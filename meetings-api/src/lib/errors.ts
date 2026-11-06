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

export class ForbiddenError extends Data.TaggedError("ForbiddenError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class ConflictError extends Data.TaggedError("ConflictError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export type AppError =
  | DatabaseError
  | NotFoundError
  | AuthError
  | ValidationError
  | ForbiddenError
  | ConflictError;
