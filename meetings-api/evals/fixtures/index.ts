import type { Fixture } from "../types";
import { answerEn } from "./answer.en";
import { answerIt } from "./answer.it";
import { summaryEn } from "./summary.en";
import { summaryIt } from "./summary.it";

export const FIXTURES: readonly Fixture[] = [...summaryEn, ...summaryIt, ...answerEn, ...answerIt];
