import { useEffect, useState } from "react";
import { popplerStatus, receiptUrl, type PopplerStatus } from "../lib/tauri";

/** Dev-only checks: receipt rendering through `receipt://` and the PDF tools in use. */
export function Spike() {
  const params = new URLSearchParams(window.location.search);
  const pdf = params.get("pdf") ?? "2030/03/receipts/acme.pdf";
  const image = params.get("image") ?? "2030/03/receipts/acme.png";
  const [poppler, setPoppler] = useState<PopplerStatus | string>("checking");

  useEffect(() => {
    popplerStatus().then(setPoppler, (e: unknown) => setPoppler(JSON.stringify(e)));
  }, []);

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, padding: 12, height: "100%", boxSizing: "border-box" }}>
      <p style={{ gridColumn: "1 / -1", margin: 0 }} data-testid="poppler">
        poppler: {typeof poppler === "string" ? poppler : `${poppler.version} (${poppler.bundled ? "bundled" : "PATH"})`}
      </p>
      <iframe title="pdf" src={`${receiptUrl(pdf)}#navpanes=0`} style={{ width: "100%", height: "90%", border: "1px solid gray" }} />
      <img alt="png" src={receiptUrl(image)} style={{ maxWidth: "100%", border: "1px solid gray" }} />
    </div>
  );
}
