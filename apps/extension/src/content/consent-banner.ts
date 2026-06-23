const BANNER_ID = "cognium-meet-consent-banner";

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "SHOW_CONSENT_BANNER") {
    showBanner();
  }
  if (message.type === "HIDE_CONSENT_BANNER") {
    hideBanner();
  }
});

function showBanner(): void {
  if (document.getElementById(BANNER_ID)) {
    return;
  }

  const banner = document.createElement("div");
  banner.id = BANNER_ID;
  banner.setAttribute("role", "status");
  banner.textContent = "This meeting is being recorded for transcription.";
  Object.assign(banner.style, {
    position: "fixed",
    top: "12px",
    left: "50%",
    transform: "translateX(-50%)",
    zIndex: "2147483647",
    background: "#b91c1c",
    color: "#fff",
    padding: "10px 16px",
    borderRadius: "8px",
    fontFamily: "system-ui, sans-serif",
    fontSize: "14px",
    fontWeight: "600",
    boxShadow: "0 4px 12px rgba(0,0,0,0.25)",
    pointerEvents: "none",
  });

  document.body.appendChild(banner);
}

function hideBanner(): void {
  document.getElementById(BANNER_ID)?.remove();
}
