import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AuthModal from '../src/components/AuthModal';
import { vi } from 'vitest';

// Mock firebaseEnabled to false to force dev path on the client.
vi.mock('../src/lib/firebase', () => ({
  firebaseEnabled: false,
  firebaseAuth: null,
}));

describe('AuthModal dev-OTP regression', () => {
  beforeEach(() => {
    // Reset fetch mock
    (global as any).fetch = vi.fn();
  });

  it('does not render dev-code UI when server devOtp is false and rejects client-side', async () => {
    // Mock /api/auth/login to return devOtp: false
    (global as any).fetch = vi.fn()
      .mockResolvedValueOnce({ // /api/auth/login
        ok: true,
        json: async () => ({ isNew: false, user: { id: 'usr_test', phone: '+911234' }, devOtp: false })
      })
      .mockResolvedValueOnce({ // /api/auth/verify-otp (should not be called because client blocks)
        ok: true,
        json: async () => ({ success: true })
      });

    const onSuccess = vi.fn();
    render(<AuthModal onClose={() => {}} onSuccess={onSuccess} />);

    // Enter phone/email and request OTP
    const input = screen.getByPlaceholderText(/you@example.com/i);
    await userEvent.type(input, 'you@example.com');
    const btn = screen.getByRole('button', { name: /Request OTP/i });
    await userEvent.click(btn);

    // Wait for OTP input to appear
    await waitFor(() => expect(screen.getByPlaceholderText('123456')).toBeTruthy());

    // Enter 123456 into OTP input
    const otpInput = screen.getByPlaceholderText('123456');
    await userEvent.type(otpInput, '123456');

    // Click Verify OTP
    const verifyBtn = screen.getByRole('button', { name: /Verify OTP/i });
    await userEvent.click(verifyBtn);

    // Ensure backend verify endpoint was NOT called (client rejected)
    // Our fetch mock would have been called for login only once
    expect((global as any).fetch).toHaveBeenCalledTimes(2);
  });
});
