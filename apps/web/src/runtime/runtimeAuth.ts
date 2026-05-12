const RUNTIME_AUTH_TOKEN_STORAGE_KEY = "octogent.apiToken";
const RUNTIME_AUTH_TOKEN_QUERY_PARAM = "octogent_token";

type LocationLike = Pick<Location, "href" | "origin">;
type HistoryLike = Pick<History, "replaceState">;
type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

let fetchAuthInstalled = false;
let originalWindowFetch: typeof window.fetch | null = null;

const normalizeToken = (value: string | null | undefined): string | null => {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const readConfiguredRuntimeBaseUrl = (): string | null => {
  const value = import.meta.env.VITE_OCTOGENT_API_ORIGIN;
  return normalizeToken(value);
};

const resolveRuntimeRequestUrl = (input: RequestInfo | URL, location: LocationLike): URL | null => {
  try {
    if (input instanceof URL) {
      return new URL(input.toString());
    }
    if (typeof input === "string") {
      return new URL(input, location.href);
    }
    return new URL(input.url, location.href);
  } catch {
    return null;
  }
};

const shouldAttachRuntimeToken = (target: URL, location: LocationLike): boolean => {
  if (target.origin === location.origin) {
    return true;
  }

  const runtimeBaseUrl = readConfiguredRuntimeBaseUrl();
  if (!runtimeBaseUrl) {
    return false;
  }

  try {
    return target.origin === new URL(runtimeBaseUrl).origin;
  } catch {
    return false;
  }
};

export const readRuntimeAuthToken = (storage: StorageLike = window.localStorage): string | null =>
  normalizeToken(storage.getItem(RUNTIME_AUTH_TOKEN_STORAGE_KEY));

export const captureRuntimeAuthTokenFromUrl = (
  location: LocationLike = window.location,
  history: HistoryLike = window.history,
  storage: StorageLike = window.localStorage,
): string | null => {
  try {
    const url = new URL(location.href);
    const token = normalizeToken(url.searchParams.get(RUNTIME_AUTH_TOKEN_QUERY_PARAM));
    if (token === null) {
      return readRuntimeAuthToken(storage);
    }

    storage.setItem(RUNTIME_AUTH_TOKEN_STORAGE_KEY, token);
    url.searchParams.delete(RUNTIME_AUTH_TOKEN_QUERY_PARAM);
    history.replaceState(null, "", url.toString());
    return token;
  } catch {
    return readRuntimeAuthToken(storage);
  }
};

export const appendRuntimeAuthToken = (rawUrl: string, token = readRuntimeAuthToken()): string => {
  if (!token) {
    return rawUrl;
  }

  try {
    const url = new URL(rawUrl, window.location.href);
    url.searchParams.set(RUNTIME_AUTH_TOKEN_QUERY_PARAM, token);
    return url.toString();
  } catch {
    return rawUrl;
  }
};

export const installRuntimeAuthFetch = (
  location: LocationLike = window.location,
  storage: StorageLike = window.localStorage,
): void => {
  if (fetchAuthInstalled) {
    return;
  }

  const originalFetch = window.fetch.bind(window);
  originalWindowFetch = window.fetch;
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const token = readRuntimeAuthToken(storage);
    if (!token) {
      return originalFetch(input, init);
    }

    const target = resolveRuntimeRequestUrl(input, location);
    if (!target || !shouldAttachRuntimeToken(target, location)) {
      return originalFetch(input, init);
    }

    const request =
      input instanceof Request ? new Request(input, init) : new Request(target.toString(), init);
    const headers = new Headers(request.headers);
    if (!headers.has("authorization") && !headers.has("x-octogent-token")) {
      headers.set("X-Octogent-Token", token);
    }

    return originalFetch(new Request(request, { headers }));
  }) as typeof window.fetch;
  fetchAuthInstalled = true;
};

export const resetRuntimeAuthForTests = (storage: StorageLike = window.localStorage): void => {
  if (originalWindowFetch) {
    window.fetch = originalWindowFetch;
    originalWindowFetch = null;
  }
  storage.removeItem(RUNTIME_AUTH_TOKEN_STORAGE_KEY);
  fetchAuthInstalled = false;
};
