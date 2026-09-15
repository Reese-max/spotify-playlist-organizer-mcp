export const REQUEST_CODES = Object.freeze({
  TIMEOUT: "TIMEOUT",
  CALLER_CANCELLED: "CALLER_CANCELLED",
  NETWORK_ERROR: "NETWORK_ERROR",
});

export class ProviderRequestError extends Error {
  constructor(code, message, { cause = null, retryable = false } = {}) {
    super(message);
    this.name = "ProviderRequestError";
    this.code = code;
    this.retryable = retryable;
    if (cause) this.cause = cause;
  }
}

export function timeoutFromEnv(env = process.env, name = "PROVIDER_TIMEOUT_MS", fallback = 15_000) {
  const value = Number(env[name]);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(Math.max(Math.round(value), 1), 120_000);
}

function cancelledError(operation, cause = null) {
  return new ProviderRequestError(
    REQUEST_CODES.CALLER_CANCELLED,
    operation + " was cancelled by the caller.",
    { cause, retryable: true },
  );
}

export async function fetchWithDeadline(
  fetchImpl,
  url,
  options = {},
  { signal, timeoutMs = 15_000, operation = "Provider request" } = {},
) {
  const boundedTimeout = Math.min(Math.max(Number(timeoutMs) || 15_000, 1), 120_000);
  if (signal?.aborted) throw cancelledError(operation, signal.reason);

  const controller = new AbortController();
  let callerCancelled = false;
  let deadlineExpired = false;
  let timer;
  let removeCallerListener = () => {};

  const requestPromise = Promise.resolve().then(() => fetchImpl(url, {
    ...options,
    signal: controller.signal,
  }));
  requestPromise.catch(() => {});

  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      deadlineExpired = true;
      controller.abort(new Error("provider deadline exceeded"));
      reject(new ProviderRequestError(
        REQUEST_CODES.TIMEOUT,
        operation + " timed out after " + boundedTimeout + " ms.",
        { retryable: true },
      ));
    }, boundedTimeout);
  });

  let cancellationPromise = null;
  if (signal) {
    cancellationPromise = new Promise((_, reject) => {
      const onCallerAbort = () => {
        callerCancelled = true;
        controller.abort(signal.reason);
        reject(cancelledError(operation, signal.reason));
      };
      signal.addEventListener("abort", onCallerAbort, { once: true });
      removeCallerListener = () => signal.removeEventListener("abort", onCallerAbort);
    });
  }

  try {
    const contenders = [requestPromise, timeoutPromise];
    if (cancellationPromise) contenders.push(cancellationPromise);
    return await Promise.race(contenders);
  } catch (error) {
    if (error instanceof ProviderRequestError) throw error;
    if (callerCancelled || signal?.aborted) throw cancelledError(operation, error);
    if (deadlineExpired) {
      throw new ProviderRequestError(
        REQUEST_CODES.TIMEOUT,
        operation + " timed out after " + boundedTimeout + " ms.",
        { cause: error, retryable: true },
      );
    }
    throw new ProviderRequestError(
      REQUEST_CODES.NETWORK_ERROR,
      operation + " failed before receiving a response.",
      { cause: error, retryable: true },
    );
  } finally {
    clearTimeout(timer);
    removeCallerListener();
  }
}

export async function awaitWithDeadline(
  value,
  { signal, timeoutMs = 15_000, operation = "Provider response" } = {},
) {
  const boundedTimeout = Math.min(Math.max(Number(timeoutMs) || 15_000, 1), 120_000);
  if (signal?.aborted) throw cancelledError(operation, signal.reason);

  let timer;
  let callerCancelled = false;
  let removeCallerListener = () => {};
  const promise = Promise.resolve(value);
  promise.catch(() => {});
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new ProviderRequestError(
        REQUEST_CODES.TIMEOUT,
        operation + " timed out after " + boundedTimeout + " ms.",
        { retryable: true },
      ));
    }, boundedTimeout);
  });
  let cancellationPromise = null;
  if (signal) {
    cancellationPromise = new Promise((_, reject) => {
      const onCallerAbort = () => {
        callerCancelled = true;
        reject(cancelledError(operation, signal.reason));
      };
      signal.addEventListener("abort", onCallerAbort, { once: true });
      removeCallerListener = () => signal.removeEventListener("abort", onCallerAbort);
    });
  }

  try {
    const contenders = [promise, timeoutPromise];
    if (cancellationPromise) contenders.push(cancellationPromise);
    return await Promise.race(contenders);
  } catch (error) {
    if (error instanceof ProviderRequestError) throw error;
    if (callerCancelled || signal?.aborted) throw cancelledError(operation, error);
    throw new ProviderRequestError(
      REQUEST_CODES.NETWORK_ERROR,
      operation + " failed while reading the response.",
      { cause: error, retryable: true },
    );
  } finally {
    clearTimeout(timer);
    removeCallerListener();
  }
}

export function retryDelayMs(response, attempt, maximum = 2_000) {
  const retryAfter = response?.headers?.get?.("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(Math.round(seconds * 1000), maximum);
    }
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.min(Math.max(date - Date.now(), 0), maximum);
  }
  return Math.min(250 * (2 ** attempt), maximum);
}

export function waitForRetry(delayMs, signal, operation = "Provider retry") {
  if (!delayMs) return Promise.resolve();
  if (signal?.aborted) return Promise.reject(cancelledError(operation, signal.reason));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(cancelledError(operation, signal.reason));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
