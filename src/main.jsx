import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
console.log("SUPABASE URL:", import.meta.env.VITE_SUPABASE_URL);

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
