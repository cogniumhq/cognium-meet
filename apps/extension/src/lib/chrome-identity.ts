/**
 * Stable account key for the signed-in Chrome profile.
 * Survives extension reinstalls on the same Chrome + Google account.
 */
export async function getChromeAccountKey(): Promise<string | undefined> {
  if (!chrome.identity?.getProfileUserInfo) {
    return undefined;
  }

  try {
    const info = await chrome.identity.getProfileUserInfo({
      accountStatus: chrome.identity.AccountStatus.ANY,
    });
    const email = info.email?.trim().toLowerCase();
    if (email) {
      return `email:${email}`;
    }
    const id = info.id?.trim();
    if (id) {
      return `chrome:${id}`;
    }
  } catch {
    return undefined;
  }

  return undefined;
}
