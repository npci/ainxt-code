// SPDX-License-Identifier: MIT
// Copyright 2026 AiNxt
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "highlight.js/styles/github-dark.css";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
