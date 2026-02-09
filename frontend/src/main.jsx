import React from "react";
import ReactDOM from "react-dom/client";
import "./styles.css";
import { AuthProvider } from "./AuthProvider.jsx";
import App from "./App.jsx";

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <AuthProvider>
      <App />
    </AuthProvider>
  </React.StrictMode>
);
