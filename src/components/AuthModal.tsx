import React, { useState } from 'react';
import { User, UserRole } from '../types';
import { X, Shield, Mail, User as UserIcon, Phone, ArrowRight, Loader, KeyRound } from 'lucide-react';
import { setTokens } from '../lib/session';

interface AuthModalProps {
  onClose: () => void;
  onSuccess: (user: User) => void;
  defaultRole?: UserRole;
}

export default function AuthModal({ onClose, onSuccess, defaultRole = 'guest' }: AuthModalProps) {
  const [isLogin, setIsLogin] = useState(true);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');

  // Step 1 = Request OTP Form, Step 2 = Enter OTP Form
  const [step, setStep] = useState<1 | 2>(1);
  const [otpCode, setOtpCode] = useState('');
  const [tempUser, setTempUser] = useState<any>(null);
  const [otpMessage, setOtpMessage] = useState('');

  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');

  // Step 1: Submit contact details to get OTP
  const handleRequestOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setIsLoading(true);

    try {
      if (isLogin) {
        if (!email && !phone) {
          setError('Please enter your Email Address or Phone Number');
          setIsLoading(false);
          return;
        }

        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ phoneOrEmail: email.trim() || phone.trim() }),
        });
        const data = await res.json();

        if (!res.ok) {
          throw new Error(data.error || 'Failed to send OTP');
        }

        if (data.isNew) {
          setIsLogin(false);
          setError('Account not found. Please fill in your details to create an account.');
          setIsLoading(false);
          return;
        }

        setTempUser(data.user);
        setOtpMessage(data.message || 'OTP sent! Use code 123456 in dev mode.');
        setStep(2);
      } else {
        if (!name || !email || !phone) {
          setError('Please fill in Name, Email, and Phone Number');
          setIsLoading(false);
          return;
        }

        const res = await fetch('/api/auth/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: name.trim(),
            email: email.trim(),
            phone: phone.trim(),
            role: defaultRole,
          }),
        });
        const data = await res.json();

        if (!res.ok) {
          throw new Error(data.error || 'Registration failed');
        }

        setTempUser(data.user);
        setOtpMessage(data.message || 'OTP sent! Use code 123456 in dev mode.');
        setStep(2);
      }
    } catch (err: any) {
      setError(err.message || 'Failed to process request');
    } finally {
      setIsLoading(false);
    }
  };

  // Step 2: Verify OTP
  const handleVerifyOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setIsLoading(true);

    try {
      if (!otpCode || otpCode.trim().length === 0) {
        setError('Please enter the 6-digit OTP code');
        setIsLoading(false);
        return;
      }

      const res = await fetch('/api/auth/verify-otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: tempUser?.id,
          code: otpCode.trim(),
        }),
      });
      const data = await res.json();

      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Invalid OTP code. Please use 123456.');
      }

      setTokens(data.token, data.refreshToken);
      localStorage.setItem('movebuddy_user_session', JSON.stringify(data.user));
      onSuccess(data.user);
    } catch (err: any) {
      setError(err.message || 'OTP verification failed');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div id="auth_portal" className="fixed inset-0 z-50 flex items-start sm:items-center justify-center bg-slate-900/70 backdrop-blur-sm p-2 sm:p-4 overflow-y-auto animate-fade-in">
      <div id="auth_container" className="relative w-full max-w-md my-auto max-h-[96vh] overflow-y-auto !bg-[#2a2e34] !text-[#e9eaec] rounded-2xl shadow-2xl transition-all border !border-[#ffb300]/30">
        
        <div className="!bg-[#ffb300] !text-[#2a2e34] p-6 relative border-b !border-[#2a2e34]/15">
          <button 
            id="close_auth_btn"
            onClick={onClose} 
            className="absolute top-4 right-4 !bg-[#2a2e34]/10 hover:!bg-[#2a2e34]/20 rounded-full p-1.5 transition-colors cursor-pointer"
          >
            <X className="w-5 h-5 !text-[#2a2e34]" />
          </button>
          <div className="flex items-center gap-2 mb-1">
            <Shield className="w-5 h-5 !text-[#2a2e34]" />
            <span className="font-display font-black tracking-wider text-xs uppercase !text-[#2a2e34]">MoveBuddy Auth</span>
          </div>
          <h2 className="font-display text-2xl font-bold !text-[#2a2e34]">Welcome to MoveBuddy</h2>
          <p className="text-sm !text-[#2a2e34]/85 mt-1 font-medium">Connecting reliable campus & office commute circles.</p>
        </div>

        <div className="p-6">
          {error && (
            <div id="auth_error" className="!bg-rose-950/80 border-l-4 border-rose-500 !text-rose-200 text-sm p-3 rounded mb-4 flex items-center justify-between">
              <span>{error}</span>
              <button onClick={() => setError('')} className="!text-rose-400 hover:!text-rose-200 font-bold ml-1 cursor-pointer">×</button>
            </div>
          )}

          {step === 2 ? (
            /* STEP 2: VERIFY OTP FORM */
            <form onSubmit={handleVerifyOtp} className="space-y-5">
              <div className="text-center space-y-2 py-2">
                <div className="w-14 h-14 bg-[#ffb300]/20 rounded-full flex items-center justify-center mx-auto text-[#ffb300]">
                  <KeyRound className="w-7 h-7" />
                </div>
                <h3 className="text-lg font-bold text-white">Enter OTP Code</h3>
                <p className="text-xs text-gray-300">
                  {otpMessage || 'OTP sent to your phone/email.'}
                </p>
                <div className="inline-block bg-[#ffb300]/10 border border-[#ffb300]/30 rounded-lg px-3 py-1.5 text-xs text-[#ffb300] font-mono">
                  Development OTP: <strong>123456</strong>
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold text-gray-300 uppercase mb-1">6-Digit OTP</label>
                <input
                  type="text"
                  required
                  maxLength={6}
                  value={otpCode}
                  onChange={(e) => setOtpCode(e.target.value)}
                  placeholder="123456"
                  className="w-full text-center text-xl tracking-widest font-mono py-3 bg-gray-800 border border-gray-700 rounded-xl text-white focus:outline-none focus:border-[#ffb300]"
                />
              </div>

              <button
                type="submit"
                disabled={isLoading}
                className="w-full py-3 bg-[#ffb300] hover:bg-[#ffa000] text-[#2a2e34] font-bold rounded-xl text-sm shadow-lg flex items-center justify-center gap-2 cursor-pointer transition disabled:opacity-50"
              >
                {isLoading ? (
                  <>
                    <Loader className="w-4 h-4 animate-spin" /> Verifying...
                  </>
                ) : (
                  <>
                    Verify OTP & Sign In <ArrowRight className="w-4 h-4" />
                  </>
                )}
              </button>

              <button
                type="button"
                onClick={() => setStep(1)}
                className="w-full text-xs text-gray-400 hover:text-gray-200 text-center"
              >
                ← Back to contact details
              </button>
            </form>
          ) : (
            /* STEP 1: CONTACT DETAILS FORM */
            <form onSubmit={handleRequestOtp} className="space-y-4">
              <div className="flex border-b border-gray-700 mb-4">
                <button
                  type="button"
                  onClick={() => { setIsLogin(true); setError(''); }}
                  className={`flex-1 py-2 text-sm font-bold border-b-2 transition ${isLogin ? 'border-[#ffb300] text-[#ffb300]' : 'border-transparent text-gray-400 hover:text-gray-200'}`}
                >
                  Sign In
                </button>
                <button
                  type="button"
                  onClick={() => { setIsLogin(false); setError(''); }}
                  className={`flex-1 py-2 text-sm font-bold border-b-2 transition ${!isLogin ? 'border-[#ffb300] text-[#ffb300]' : 'border-transparent text-gray-400 hover:text-gray-200'}`}
                >
                  Create Account
                </button>
              </div>

              {!isLogin && (
                <div>
                  <label className="block text-xs font-bold text-gray-300 uppercase mb-1">Full Name</label>
                  <div className="relative">
                    <UserIcon className="w-4 h-4 text-gray-400 absolute left-3 top-3" />
                    <input
                      type="text"
                      required
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="John Doe"
                      className="w-full pl-9 pr-3 py-2 bg-gray-800 border border-gray-700 rounded-xl text-sm text-white focus:outline-none focus:border-[#ffb300]"
                    />
                  </div>
                </div>
              )}

              <div>
                <label className="block text-xs font-bold text-gray-300 uppercase mb-1">Email Address</label>
                <div className="relative">
                  <Mail className="w-4 h-4 text-gray-400 absolute left-3 top-3" />
                  <input
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@example.com"
                    className="w-full pl-9 pr-3 py-2 bg-gray-800 border border-gray-700 rounded-xl text-sm text-white focus:outline-none focus:border-[#ffb300]"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold text-gray-300 uppercase mb-1">
                  Phone Number {!isLogin ? '' : '(Optional)'}
                </label>
                <div className="relative">
                  <Phone className="w-4 h-4 text-gray-400 absolute left-3 top-3" />
                  <input
                    type="tel"
                    required={!isLogin}
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    placeholder="+91 9876543210"
                    className="w-full pl-9 pr-3 py-2 bg-gray-800 border border-gray-700 rounded-xl text-sm text-white focus:outline-none focus:border-[#ffb300]"
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={isLoading}
                className="w-full py-3 bg-[#ffb300] hover:bg-[#ffa000] text-[#2a2e34] font-bold rounded-xl text-sm shadow-lg flex items-center justify-center gap-2 cursor-pointer transition disabled:opacity-50"
              >
                {isLoading ? (
                  <>
                    <Loader className="w-4 h-4 animate-spin" /> Requesting OTP...
                  </>
                ) : (
                  <>
                    {isLogin ? 'Request OTP' : 'Send Registration OTP'} <ArrowRight className="w-4 h-4" />
                  </>
                )}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
