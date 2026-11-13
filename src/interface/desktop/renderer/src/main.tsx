import React from "react";
import { createRoot } from "react-dom/client";
import { DesktopApp } from "./ui.js";
import "./tailwind.css";

// Lets styles clear the macOS traffic lights, which sit over the top bar.
if (/Mac/.test(navigator.platform)) document.documentElement.classList.add("mac-inset");

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <DesktopApp />
  </React.StrictMode>,
);
