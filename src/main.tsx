import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ConvexReactClient } from "convex/react";
import { ConvexAuthProvider } from "@convex-dev/auth/react";
import App from "./App";
import { ErrorBoundary } from "./ui";
import "./index.css";

const convex = new ConvexReactClient(import.meta.env.VITE_CONVEX_URL as string);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ConvexAuthProvider client={convex}>
      {/* The outermost net. Every screen has its own boundary, but a failure
          in the shell itself — or in an element built before a screen's
          boundary mounts — would otherwise leave a judge with a blank page and
          no way back. */}
      <ErrorBoundary fallbackLabel="loading Ombuds">
        <App />
      </ErrorBoundary>
    </ConvexAuthProvider>
  </StrictMode>,
);
