import { createClient } from '@supabase/supabase-js';

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
