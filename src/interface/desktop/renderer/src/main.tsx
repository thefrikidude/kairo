import React from "react";
import { createRoot } from "react-dom/client";
import { DesktopApp } from "./ui.js";
import "./style.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <DesktopApp />
  </React.StrictMode>,
);
