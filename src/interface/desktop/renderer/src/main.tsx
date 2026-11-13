import React from "react";
import { createRoot } from "react-dom/client";
import { DesktopApp } from "./ui.js";
import "./tailwind.css";

// Lets styles clear the macOS traffic lights, which sit over the top bar.
if (/Mac/.test(navigator.platform)) document.documentElement.classList.add("mac-inset");

// The title-bar row stays the size of the native window controls whatever the page zoom is, and
// stops acting as a drag area while zoomed (Electron places drag regions wrongly then, so they
// would swallow clicks on the buttons).
window.kairo.onZoom((percent) => {
  const root = document.documentElement;
  root.style.setProperty("--page-zoom", String(percent / 100));
  root.classList.toggle("page-zoomed", percent !== 100);
});

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <DesktopApp />
  </React.StrictMode>,
);
