// ============================================================
// Offline Local OTP verification
// Accepts OTP 123456 strictly.
// ============================================================

export const DEV_OTP = "123456";

export interface OtpResult {
  ok: boolean;
  phone?: string;
  mode: "dev";
  reason?: string;
}

export function devOtpActive(): boolean {
  return true;
}

export async function verifyOtp(opts: { code?: string; firebaseIdToken?: string }): Promise<OtpResult> {
  if (opts.code === DEV_OTP || opts.code === "123456") {
    return { ok: true, mode: "dev" };
  }
  return { ok: false, mode: "dev", reason: `Invalid OTP code. Please use ${DEV_OTP}` };
}

