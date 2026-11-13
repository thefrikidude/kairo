import React from "react";
import { createRoot } from "react-dom/client";
import { DesktopApp } from "./ui.js";
import "./tailwind.css";

// Lets styles clear the macOS traffic lights, which sit over the top bar.
if (/Mac/.test(navigator.platform)) document.documentElement.classList.add("mac-inset");

// Electron places drag regions wrongly while the page is zoomed, which would swallow clicks on the
// top bar's buttons, so the top bar stops acting as a drag area then.
window.kairo.onZoom((percent) =>
  document.documentElement.classList.toggle("page-zoomed", percent !== 100),
);

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <DesktopApp />
  </React.StrictMode>,
);
