"use client";

export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  return (
    <html lang="en" style={{ background: "#0a0a0a", color: "#fafafa" }}>
      <body style={{ fontFamily: "system-ui, sans-serif", padding: 24, textAlign: "center" }}>
        <h1 style={{ letterSpacing: "0.14em", fontSize: 20 }}>FLOWGUARD</h1>
        <p>The app failed to start.</p>
        <p style={{ fontSize: 11, opacity: 0.7 }}>{error.digest ?? error.message}</p>
        <button type="button" onClick={() => window.location.reload()} style={{ padding: "6px 12px" }}>
          Reload
        </button>
      </body>
    </html>
  );
}
