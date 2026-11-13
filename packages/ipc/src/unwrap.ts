// Narrowing helpers for the generated command results.
//
// tauri-specta's default error mode wraps every command as
// `Promise<{ status: "ok"; data: T } | { status: "error"; error: E }>`.
// Components should not repeat that check at every call site; `unwrap` returns
// the data or throws an `IpcError` the UI can show.

/** A failure object the Rust side sends (our `AppError`). */
export interface IpcFailure {
  code?: unknown;
  message?: unknown;
}

/** The result union every generated command returns. */
export type CommandResult<T, E = unknown> = { status: "ok"; data: T } | { status: "error"; error: E };

/** A command failure as a real `Error`, carrying the stable code. */
export class IpcError extends Error {
  /** Stable code such as `store.open_failed`. */
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "IpcError";
    this.code = code;
  }

  /** Wraps whatever the command rejected with, keeping `code`/`message` when present. */
  static from(error: unknown): IpcError {
    if (error instanceof IpcError) return error;
    const failure = error as IpcFailure | null;
    const code = typeof failure?.code === "string" ? failure.code : "ipc.failed";
    const message =
      typeof failure?.message === "string" ? failure.message : error instanceof Error ? error.message : String(error);
    return new IpcError(code, message, { cause: error });
  }
}

/** Returns the data of a settled result, or throws its `IpcError`. */
export function unwrap<T, E>(result: CommandResult<T, E>): T;
export function unwrap<T, E>(result: Promise<CommandResult<T, E>>): Promise<T>;
export function unwrap<T, E>(result: CommandResult<T, E> | Promise<CommandResult<T, E>>): T | Promise<T> {
  const settle = (value: CommandResult<T, E>): T => {
    if (value.status === "ok") return value.data;
    throw IpcError.from(value.error);
  };
  if (result instanceof Promise) return result.then(settle);
  return settle(result);
}
