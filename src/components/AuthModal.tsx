import React, { useState } from 'react';
import { User, UserRole } from '../types';
import { X, Shield, Mail, Lock, User as UserIcon, Phone, CheckCircle, ArrowRight, Loader, RefreshCw } from 'lucide-react';
import { setTokens } from '../lib/session';
import { signUpWithEmail, signInWithEmail, resendVerificationEmail } from '../lib/supabaseClient';

interface AuthModalProps {
  onClose: () => void;
  onSuccess: (user: User) => void;
  defaultRole?: UserRole;
}

export default function AuthModal({ onClose, onSuccess, defaultRole = 'guest' }: AuthModalProps) {
  const [isLogin, setIsLogin] = useState(true);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [phone, setPhone] = useState('');
  const [gender, setGender] = useState<'male' | 'female' | 'other'>('male');
  const [collegeOrCompany, setCollegeOrCompany] = useState('');

  // Screen states: 1 = Auth Form, 2 = Check Email Banner, 3 = Email Sent Success
  const [screen, setScreen] = useState<1 | 2>(1);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [resendStatus, setResendStatus] = useState('');

  const syncBackendUser = async (supabaseAuthUserId: string, userEmail: string, userName?: string, userPhone?: string, userRole?: string) => {
    const res = await fetch('/api/auth/sync-supabase-user', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        supabaseAuthUserId,
        email: userEmail,
        name: userName,
        phone: userPhone,
        role: userRole || defaultRole
      })
    });
    const data = await res.json();
    if (!res.ok || !data.success) {
      throw new Error(data.error || 'Failed to synchronize user account');
    }
    setTokens(data.token, data.refreshToken);
    return data.user;
  };

  const handleAuthSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setIsLoading(true);

    if (isLogin) {
      // ── SUPABASE LOGIN FLOW ──
      if (!email || !password) {
        setError('Please enter both Email and Password');
        setIsLoading(false);
        return;
      }

      const { user, session, error: loginErr } = await signInWithEmail(email.trim(), password);

      if (loginErr || !user) {
        if (loginErr?.toLowerCase().includes('email not confirmed')) {
          setScreen(2);
          setIsLoading(false);
          return;
        }
        setError(loginErr || 'Invalid email or password');
        setIsLoading(false);
        return;
      }

      // Sync verified Supabase user with backend Prisma DB
      try {
        const mbUser = await syncBackendUser(user.id, user.email || email, name, phone, defaultRole);
        setIsLoading(false);
        onSuccess(mbUser);
      } catch (err: any) {
        setError(err.message);
        setIsLoading(false);
      }

    } else {
      // ── SUPABASE REGISTER FLOW ──
      if (!name || !email || !password) {
        setError('Please fill in Name, Email, and Password');
        setIsLoading(false);
        return;
      }

      if (password.length < 6) {
        setError('Password must be at least 6 characters');
        setIsLoading(false);
        return;
      }

      const { user, session, error: signupErr, requiresEmailConfirmation } = await signUpWithEmail(
        email.trim(),
        password,
        { name, phone, role: defaultRole }
      );

      if (signupErr) {
        setError(signupErr);
        setIsLoading(false);
        return;
      }

      if (requiresEmailConfirmation) {
        setScreen(2); // Show "Check your Email Inbox" screen
        setIsLoading(false);
        return;
      }

      // If instant session granted
      if (user) {
        try {
          const mbUser = await syncBackendUser(user.id, user.email || email, name, phone, defaultRole);
          setIsLoading(false);
          onSuccess(mbUser);
        } catch (err: any) {
          setError(err.message);
          setIsLoading(false);
        }
      }
    }
  };

  const handleResendEmail = async () => {
    if (!email) return;
    setResendStatus('Sending verification email...');
    const { error: resendErr } = await resendVerificationEmail(email.trim());
    if (resendErr) {
      setResendStatus(`Failed: ${resendErr}`);
    } else {
      setResendStatus('✅ Verification email sent! Please check your inbox.');
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

          {screen === 2 ? (
            /* EMAIL VERIFICATION REQUIRED SCREEN */
            <div className="space-y-5 text-center py-4">
              <div className="w-16 h-16 bg-[#ffb300]/20 rounded-full flex items-center justify-center mx-auto text-[#ffb300]">
                <Mail className="w-8 h-8" />
              </div>

              <div>
                <h3 className="text-xl font-bold text-white">Check Your Email Inbox 📬</h3>
                <p className="text-sm text-gray-300 mt-2">
                  We sent a real verification link to <strong className="text-[#ffb300]">{email}</strong>.
                </p>
                <p className="text-xs text-gray-400 mt-1">
                  Please click the link inside your email to verify your MoveBuddy account.
                </p>
              </div>

              <div className="pt-3 border-t border-gray-700 space-y-3">
                {resendStatus && (
                  <p className="text-xs font-semibold text-[#ffb300]">{resendStatus}</p>
                )}
                <button
                  type="button"
                  onClick={handleResendEmail}
                  className="w-full py-2.5 px-4 bg-gray-700 hover:bg-gray-600 text-white rounded-xl text-sm font-semibold flex items-center justify-center gap-2 cursor-pointer transition"
                >
                  <RefreshCw className="w-4 h-4" /> Resend Verification Email
                </button>

                <button
                  type="button"
                  onClick={() => { setScreen(1); setIsLogin(true); }}
                  className="text-xs text-[#ffb300] hover:underline"
                >
                  Already verified? Log in here
                </button>
              </div>
            </div>
          ) : (
            /* LOGIN / REGISTER FORM SCREEN */
            <form onSubmit={handleAuthSubmit} className="space-y-4">
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
                <label className="block text-xs font-bold text-gray-300 uppercase mb-1">Password</label>
                <div className="relative">
                  <Lock className="w-4 h-4 text-gray-400 absolute left-3 top-3" />
                  <input
                    type="password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    className="w-full pl-9 pr-3 py-2 bg-gray-800 border border-gray-700 rounded-xl text-sm text-white focus:outline-none focus:border-[#ffb300]"
                  />
                </div>
              </div>

              {!isLogin && (
                <div>
                  <label className="block text-xs font-bold text-gray-300 uppercase mb-1">Phone Number (Optional)</label>
                  <div className="relative">
                    <Phone className="w-4 h-4 text-gray-400 absolute left-3 top-3" />
                    <input
                      type="tel"
                      value={phone}
                      onChange={(e) => setPhone(e.target.value)}
                      placeholder="+91 9876543210"
                      className="w-full pl-9 pr-3 py-2 bg-gray-800 border border-gray-700 rounded-xl text-sm text-white focus:outline-none focus:border-[#ffb300]"
                    />
                  </div>
                </div>
              )}

              <button
                type="submit"
                disabled={isLoading}
                className="w-full py-3 bg-[#ffb300] hover:bg-[#ffa000] text-[#2a2e34] font-bold rounded-xl text-sm shadow-lg flex items-center justify-center gap-2 cursor-pointer transition disabled:opacity-50"
              >
                {isLoading ? (
                  <>
                    <Loader className="w-4 h-4 animate-spin" /> Processing...
                  </>
                ) : (
                  <>
                    {isLogin ? 'Sign In to MoveBuddy' : 'Create Account'} <ArrowRight className="w-4 h-4" />
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
