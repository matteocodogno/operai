import { Data } from "effect";

export class DatabaseError extends Data.TaggedError("DatabaseError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class NotFoundError extends Data.TaggedError("NotFoundError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class AuthError extends Data.TaggedError("AuthError")<{
  readonly message: string;
  readonly cause?: unknown;
  readonly statusCode?: number;
}> {}

export class ValidationError extends Data.TaggedError("ValidationError")<{
  readonly message: string;
  readonly cause?: unknown;
  readonly fields?: Record<string, string[]>;
}> {}

export class SizeError extends Data.TaggedError("SizeError")<{
  readonly message: string;
  readonly actualBytes: number;
  readonly limitBytes: number;
}> {}

export type AppError =
  | DatabaseError
  | NotFoundError
  | AuthError
  | ValidationError
  | SizeError;
