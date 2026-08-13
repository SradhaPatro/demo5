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

function loadRazorpaySdk(): Promise<boolean> {
  return new Promise((resolve) => {
    if ((window as any).Razorpay) return resolve(true);
    const script = document.createElement('script');
    script.src = 'https://checkout.razorpay.com/v1/checkout.js';
    script.onload = () => resolve(true);
    script.onerror = () => resolve(false);
    document.body.appendChild(script);
  });
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
  try {
    // 1. Create order on MoveBuddy backend
    const res = await fetch('/api/payments/create-order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        planName: params.planName,
        role: params.role,
        distanceKm: params.distanceKm || 0,
      }),
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok || !data.orderId) {
      return { success: false, error: data.error || 'Could not initiate payment order.' };
    }

    // 2. If backend is in devMode or no Key ID returned, bypass Razorpay UI
    if (data.devMode || !data.keyId) {
      const devPaymentId = `pay_dev_${Date.now()}`;
      return verify(data.orderId, devPaymentId, 'dev', params);
    }

    // 3. Load Razorpay Checkout SDK
    const sdkLoaded = await loadRazorpaySdk();
    if (!sdkLoaded) {
      return { success: false, error: 'Failed to load Razorpay SDK. Check network connection.' };
    }

    // 4. Open Razorpay Modal Window
    return new Promise((resolve) => {
      const options = {
        key: data.keyId,
        amount: Math.round((data.amount || 0) * 100),
        currency: data.currency || 'INR',
        name: 'MoveBuddy Commute',
        description: `${params.role.toUpperCase()} - ${params.planName}`,
        order_id: data.orderId,
        prefill: {
          name: data.userName || '',
          email: data.userEmail || '',
          contact: data.userPhone || '',
        },
        theme: { color: '#F59E0B' },
        handler: async function (response: any) {
          const result = await verify(
            response.razorpay_order_id,
            response.razorpay_payment_id,
            response.razorpay_signature,
            params
          );
          resolve(result);
        },
        modal: {
          ondismiss: function () {
            resolve({ success: false, error: 'Payment popup closed by user.' });
          },
        },
      };

      const rzp = new (window as any).Razorpay(options);
      rzp.open();
    });
  } catch (err: any) {
    return { success: false, error: err?.message || 'Checkout initiation failed.' };
  }
}
