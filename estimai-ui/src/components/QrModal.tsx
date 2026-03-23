import { useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'

interface Props {
  shareUrl: string
  projectName: string
  onClose: () => void
}

export default function QrModal({ shareUrl, projectName, onClose }: Props) {
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    QRCode.toDataURL(shareUrl, {
      width: 300,
      margin: 1,
      color: { dark: '#1e1e3a', light: '#ffffff' },
    }).then(setQrDataUrl)
  }, [shareUrl])

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  function handleCopy() {
    navigator.clipboard.writeText(shareUrl).then(() => {
      setCopied(true)
      if (copiedTimer.current) clearTimeout(copiedTimer.current)
      copiedTimer.current = setTimeout(() => setCopied(false), 2000)
    })
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="bg-ink-soft border border-rule rounded-lg shadow-2xl w-full max-w-xs mx-4 p-5 flex flex-col items-center gap-4"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between w-full">
          <div>
            <h2 className="font-disp text-sm font-bold text-text">Share Estimate</h2>
            {projectName && (
              <p className="text-[11px] text-muted mt-0.5">{projectName}</p>
            )}
          </div>
          <button
            onClick={onClose}
            className="text-muted hover:text-text text-lg leading-none transition-colors"
          >
            ×
          </button>
        </div>

        <div className="bg-white rounded-md p-2 shadow-inner">
          {qrDataUrl
            ? <img src={qrDataUrl} alt="QR code" className="w-48 h-48" />
            : <div className="w-48 h-48 flex items-center justify-center text-muted text-xs">Generating…</div>
          }
        </div>

        <p className="text-[11px] text-muted text-center leading-relaxed">
          Scan to open a read-only view<br />of this estimate on any device.
        </p>

        <button
          onClick={handleCopy}
          className="w-full py-1.5 text-[11px] font-medium border transition-colors text-center
            border-acc/30 text-acc hover:border-acc hover:bg-acc/5"
        >
          {copied ? '✓ Link copied!' : '⤴ Copy link'}
        </button>
      </div>
    </div>
  )
}
