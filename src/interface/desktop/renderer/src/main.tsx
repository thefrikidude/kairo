import React from "react";
import { createRoot } from "react-dom/client";
import { DesktopApp } from "./ui.js";
import "./tailwind.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <DesktopApp />
  </React.StrictMode>,
);
