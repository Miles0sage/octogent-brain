import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { captureRuntimeAuthTokenFromUrl, installRuntimeAuthFetch } from "./runtime/runtimeAuth";
import "./styles.css";

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Root container '#root' was not found.");
}

captureRuntimeAuthTokenFromUrl();
installRuntimeAuthFetch();

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
