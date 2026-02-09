import { auth } from "./firebase";

/**
 * Backend 호출 시 Firebase ID token을 Authorization 헤더로 첨부
 */
export async function postAnalyze(payload) {
  const user = auth.currentUser;
  if (!user) throw new Error("Not authenticated");

  const token = await user.getIdToken();

  const res = await fetch("/api/analyze", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error(t || `Request failed: ${res.status}`);
  }
  return await res.json();
}
