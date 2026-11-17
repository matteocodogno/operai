//! `letterhead-api worker`: renders one job at a time from stdin to stdout (task T11; ADR 20261116-renders-run-
//! in-killable-worker-processes-and-concurrency-is-bounded-by-memory).
//!
//! The supervisor starts this with an empty environment, nothing on stderr and the two pipes. A worker therefore
//! holds no secret, no database, no bucket and no credential; it has no network client (it links none of the
//! supervisor's code paths that open a socket) and writes nothing to disk: its only output is the result frame on
//! stdout. After every job, whatever its outcome, it evicts the memoisation cache of Typst, so no document stays
//! in memory for the next (AC-3.7).
//!
//! It ends when its stdin closes (the supervisor is gone or let it go), on a frame it cannot read, after a job it
//! could not do (a panic: its state is not to be trusted), and, when `--hard-deadline-ms` is given, when one job
//! has run longer than that. The last is for a supervisor that died without killing it: the supervisor's own
//! deadline is shorter and kills first (AC-3.4), so a worker that outlives its supervisor does not spin for ever.
//!
//! A test checks that this file and the frame code it uses name no socket, file, program or environment variable.
//! That is a tripwire for the rule above, not a proof of it; the pool's tests add a dynamic check.

use std::io;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::process::ExitCode;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use letterhead_engine::layout::{LayoutError, check_fit, layout};
use letterhead_engine::render::{RenderError, RenderOptions, render_with};

use crate::pool::job::{Decoded, Meta, Output, PageInfo, Refusal, Reply, decode_job};
use crate::pool::wire::{read_frame, write_frame};

/// How often the watchdog looks at the clock.
const WATCHDOG_TICK: Duration = Duration::from_millis(100);

pub fn run(args: &[String]) -> ExitCode {
    let hard_deadline = match parse_args(args) {
        Some(deadline) => deadline,
        None => {
            eprintln!("usage: letterhead-api worker [--hard-deadline-ms <n>]");
            return ExitCode::from(2);
        }
    };
    // Nothing that a job holds may reach a log: a panic message can quote a template value.
    std::panic::set_hook(Box::new(|_| {}));

    let busy_since = Arc::new(AtomicU64::new(0));
    let base = Instant::now();
    if let Some(limit) = hard_deadline {
        watch(Arc::clone(&busy_since), base, limit);
    }

    let stdin = io::stdin();
    let mut input = stdin.lock();
    let stdout = io::stdout();
    let mut output = stdout.lock();
    loop {
        let parts = match read_frame(&mut input) {
            Ok(Some(parts)) => parts,
            Ok(None) => return ExitCode::SUCCESS,
            Err(_) => return ExitCode::FAILURE,
        };
        busy_since.store(elapsed_ms(base) + 1, Ordering::Relaxed);
        let (reply, body) =
            catch_unwind(AssertUnwindSafe(|| serve(parts))).unwrap_or((Reply::Failed, Vec::new()));
        // Before the answer leaves, so that what the supervisor measures afterwards is a worker with no cache.
        comemo::evict(0);
        let Ok(head) = serde_json::to_vec(&reply) else {
            return ExitCode::FAILURE;
        };
        let mut frame: Vec<&[u8]> = Vec::with_capacity(1 + body.len());
        frame.push(&head);
        frame.extend(body.iter().map(Vec::as_slice));
        if write_frame(&mut output, &frame).is_err() {
            return ExitCode::FAILURE;
        }
        busy_since.store(0, Ordering::Relaxed);
        if reply == Reply::Failed {
            return ExitCode::FAILURE;
        }
    }
}

/// `Some(None)`: no argument. `Some(Some(d))`: `--hard-deadline-ms`. `None`: not understood.
fn parse_args(args: &[String]) -> Option<Option<Duration>> {
    match args {
        [] => Some(None),
        [flag, value] if flag == "--hard-deadline-ms" => {
            let millis: u64 = value.parse().ok().filter(|&m| m > 0)?;
            Some(Some(Duration::from_millis(millis)))
        }
        _ => None,
    }
}

fn elapsed_ms(base: Instant) -> u64 {
    u64::try_from(base.elapsed().as_millis()).unwrap_or(u64::MAX - 1)
}

/// Ends the process when one job has run for longer than `limit`.
fn watch(busy_since: Arc<AtomicU64>, base: Instant, limit: Duration) {
    let limit_ms = u64::try_from(limit.as_millis()).unwrap_or(u64::MAX);
    let spawned = std::thread::Builder::new()
        .name("watchdog".to_owned())
        .spawn(move || {
            loop {
                std::thread::sleep(WATCHDOG_TICK);
                let since = busy_since.load(Ordering::Relaxed);
                if since != 0 && elapsed_ms(base).saturating_sub(since - 1) > limit_ms {
                    std::process::exit(124);
                }
            }
        });
    if spawned.is_err() {
        // No watchdog is worse than a worker that does not start: the supervisor's deadline still holds, but the
        // orphan case would not.
        std::process::exit(70);
    }
}

/// One job: the reply and the binary parts that follow it.
fn serve(parts: Vec<Vec<u8>>) -> (Reply, Vec<Vec<u8>>) {
    let Ok(job) = decode_job(parts) else {
        return (Reply::Failed, Vec::new());
    };
    #[cfg(any(test, feature = "test-slow"))]
    if let Some(layout) = &job.test
        && let Some(done) = crate::pool::testing::run(layout)
    {
        return done;
    }
    render_job(job)
}

/// The fit check of a configuration (AC-5.2): the problems, as the JSON the answer has, or a refusal for a fault.
fn fit_job(job: &Decoded) -> (Reply, Vec<Vec<u8>>) {
    let Some(layout) = layout(job.version.layout_version) else {
        let error = RenderError::Layout(LayoutError::UnknownLayout(job.version.layout_version));
        return (Reply::Refused(refusal(&error)), Vec::new());
    };
    match check_fit(layout, &job.version.config, &job.assets) {
        Ok(problems) => {
            // A problem that cannot be written down must not become "it fits".
            let problems: Result<Vec<_>, _> = problems.iter().map(serde_json::to_value).collect();
            match problems {
                Ok(problems) => (Reply::Fit { problems }, Vec::new()),
                Err(_) => (Reply::Failed, Vec::new()),
            }
        }
        Err(error) => (
            Reply::Refused(refusal(&RenderError::Layout(error))),
            Vec::new(),
        ),
    }
}

fn render_job(job: Decoded) -> (Reply, Vec<Vec<u8>>) {
    if matches!(job.output, Output::Fit) {
        return fit_job(&job);
    }
    // `decode_job` refuses a document without its request.
    let Some(request) = job.request.as_ref() else {
        return (Reply::Failed, Vec::new());
    };
    let options = RenderOptions {
        mark_missing: job.mark_missing,
    };
    let rendered = match render_with(request, &job.version, &job.assets, options) {
        Ok(rendered) => rendered,
        Err(error) => return (Reply::Refused(refusal(&error)), Vec::new()),
    };
    let meta = Meta {
        letterhead_version: rendered.letterhead_version,
        layout_version: rendered.layout_version,
        page_count: rendered.page_count,
        missing_placeholders: rendered
            .missing_placeholders
            .iter()
            .map(|name| (*name).to_owned())
            .collect(),
        unprintable_characters: rendered.unprintable_characters,
    };
    match job.output {
        Output::Fit => (Reply::Failed, Vec::new()),
        Output::Pdf => match rendered.pdf() {
            Ok(pdf) => (Reply::Pdf { meta }, vec![pdf]),
            Err(error) => (Reply::Refused(refusal(&error)), Vec::new()),
        },
        Output::Preview(selection) => match rendered.preview(&selection) {
            Ok(pages) => {
                let infos = pages
                    .iter()
                    .map(|page| PageInfo {
                        number: page.number,
                        width: page.width,
                        height: page.height,
                        text: page.text.clone(),
                    })
                    .collect();
                let pngs = pages.into_iter().map(|page| page.png).collect();
                (Reply::Preview { meta, pages: infos }, pngs)
            }
            Err(error) => (Reply::Refused(refusal(&error)), Vec::new()),
        },
    }
}

/// What of an engine refusal may leave the worker: the code, and where in the configuration or the request it
/// points. Never a value.
fn refusal(error: &RenderError) -> Refusal {
    use letterhead_engine::layout::LayoutError;
    let (path, reason) = match error {
        RenderError::Layout(LayoutError::Overflow { variant, frame }) => {
            (Some(LayoutError::overflow_path(variant, *frame)), None)
        }
        RenderError::Layout(LayoutError::Image { path, reason }) => {
            (Some(path.clone()), Some(reason.as_str().to_owned()))
        }
        RenderError::Layout(LayoutError::InvalidConfig { path, reason }) => {
            (Some(path.clone()), Some(reason.as_str().to_owned()))
        }
        _ => (None, None),
    };
    Refusal {
        code: error.code().to_owned(),
        path,
        reason,
    }
}
