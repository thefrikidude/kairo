import React from "react";
import { createRoot } from "react-dom/client";
import { DesktopApp } from "./ui.js";
import { MapWindow, isMapWindow } from "./map-window.js";
import "./style.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>{isMapWindow() ? <MapWindow /> : <DesktopApp />}</React.StrictMode>,
);
