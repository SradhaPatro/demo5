// Razorpay checkout flow: create a server-side order, open the Razorpay modal,
// then verify the signature server-side (which activates the subscription).
// The global fetch interceptor (lib/api) attaches the JWT automatically.

export interface CheckoutResult {
  success: boolean;
  subscription?: any;
  matches?: any[];
  error?: string;
}

interface CheckoutParams {
  planName: '7-Day Plan' | '15-Day Plan' | 'Monthly Plan';
  role: 'guest' | 'host';
  distanceKm?: number;
  // Subscription details passed through to /verify so the sub is created with the route:
  subDetails: Record<string, unknown>;
}

async function verify(orderId: string, paymentId: string, signature: string, params: CheckoutParams): Promise<CheckoutResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const res = await fetch('/api/payments/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        orderId, paymentId, signature,
        planName: params.planName, role: params.role, distanceKm: params.distanceKm,
        ...params.subDetails,
      }),
      signal: ctrl.signal,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.success) return { success: false, error: body.error || 'Payment verification failed' };
    return { success: true, subscription: body.subscription, matches: body.matches };
  } catch (e: any) {
    if (e?.name === 'AbortError') return { success: false, error: 'Payment verification timed out — please try again' };
    return { success: false, error: e?.message || 'Payment verification failed' };
  } finally {
    clearTimeout(timer);
  }
}

export async function startCheckout(params: CheckoutParams): Promise<CheckoutResult> {
  const uniqueId = Math.random().toString(36).substring(2, 9) + Date.now().toString(36);
  const devOrderId = `order_dev_${uniqueId}`;
  const devPaymentId = `pay_dev_${uniqueId}`;
  return verify(devOrderId, devPaymentId, 'dev', params);
}
