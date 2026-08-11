import { createClient, Session, User as SupabaseUser } from '@supabase/supabase-js';

const supabaseUrl = (import.meta.env.VITE_SUPABASE_URL as string) || 'https://snrdfprgypioxhskthcm.supabase.co';
const supabaseAnonKey = (import.meta.env.VITE_SUPABASE_ANON_KEY as string) || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNucmRmcHJneXBpb3hoc2t0aGNtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODYxNzU3MDcsImV4cCI6MjEwMTc1MTcwN30.OavLMMUDp3XQTuYrf7gsi_-Gy1qG7bMVNzhtV5TNFfE';

export const supabase = createClient(
  supabaseUrl,
  supabaseAnonKey
);

export const BUCKET_NAME = 'verification-documents';

/**
 * Upload a document file to Supabase Private Storage bucket
 * Returns the storagePath string e.g. "verifications/{userId}/{docType}_{timestamp}.ext"
 */
export async function uploadVerificationDoc(
  file: File,
  userId: string,
  docType: string
): Promise<{ storagePath: string; error?: string }> {
  try {
    const ext = file.name.split('.').pop() || 'jpg';
    const filePath = `verifications/${userId}/${docType.toLowerCase()}_${Date.now()}.${ext}`;

    const { data, error } = await supabase.storage
      .from(BUCKET_NAME)
      .upload(filePath, file, {
        cacheControl: '3600',
        upsert: true,
      });

    if (error) {
      console.error('[Supabase Storage Upload Error]:', error);
      return { storagePath: '', error: error.message };
    }

    return { storagePath: data.path };
  } catch (err: any) {
    console.error('[Supabase Storage Exception]:', err);
    return { storagePath: '', error: err?.message || 'Failed to upload document to storage' };
  }
}

// ── SUPABASE AUTHENTICATION HELPERS ─────────────────────────────────────────

export async function signUpWithEmail(
  email: string,
  password: string,
  metadata: { name: string; phone?: string; role?: string }
): Promise<{ user: SupabaseUser | null; session: Session | null; error?: string; requiresEmailConfirmation?: boolean }> {
  try {
    const redirectUrl = typeof window !== 'undefined' ? `${window.location.origin}` : 'https://demo5-tau-silk.vercel.app';
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: redirectUrl,
        data: metadata
      }
    });

    if (error) return { user: null, session: null, error: error.message };
    
    const requiresEmailConfirmation = !data.session && !!data.user;
    return {
      user: data.user,
      session: data.session,
      requiresEmailConfirmation
    };
  } catch (err: any) {
    return { user: null, session: null, error: err?.message || 'Signup failed' };
  }
}

export async function signInWithEmail(
  email: string,
  password: string
): Promise<{ user: SupabaseUser | null; session: Session | null; error?: string }> {
  try {
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password
    });

    if (error) return { user: null, session: null, error: error.message };
    return { user: data.user, session: data.session };
  } catch (err: any) {
    return { user: null, session: null, error: err?.message || 'Login failed' };
  }
}

export async function signOutUser(): Promise<{ error?: string }> {
  try {
    const { error } = await supabase.auth.signOut();
    if (error) return { error: error.message };
    return {};
  } catch (err: any) {
    return { error: err?.message || 'Signout failed' };
  }
}

export async function getActiveSupabaseSession(): Promise<Session | null> {
  try {
    const { data } = await supabase.auth.getSession();
    return data.session;
  } catch {
    return null;
  }
}

export async function resendVerificationEmail(email: string): Promise<{ error?: string }> {
  try {
    const redirectUrl = typeof window !== 'undefined' ? `${window.location.origin}` : 'https://demo5-tau-silk.vercel.app';
    const { error } = await supabase.auth.resend({
      type: 'signup',
      email,
      options: { emailRedirectTo: redirectUrl }
    });
    if (error) return { error: error.message };
    return {};
  } catch (err: any) {
    return { error: err?.message || 'Failed to resend email' };
  }
}
