import { Pool } from 'pg';
import * as dotenv from 'dotenv';
import * as path from 'path';

// Load .env
dotenv.config({ path: path.join(__dirname, '../../.env') });

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  console.error('Error: DATABASE_URL not found in .env');
  process.exit(1);
}

async function main() {
  console.log('Connecting to database...');
  const pool = new Pool({
    connectionString,
    ssl: { rejectUnauthorized: false }
  });

  // Step 1: Create the bucket
  try {
    console.log('Creating "verification-documents" bucket...');
    await pool.query(`
      INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
      VALUES (
        'verification-documents', 
        'verification-documents', 
        true, 
        10485760, -- 10MB limit
        ARRAY['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
      )
      ON CONFLICT (id) DO UPDATE SET 
        public = true,
        file_size_limit = 10485760,
        allowed_mime_types = ARRAY['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
    `);
    console.log('Bucket "verification-documents" created/updated successfully.');
  } catch (err) {
    console.error('Could not create bucket:', err);
  }

  // Step 2: Try cleaning up old policies
  try {
    console.log('Cleaning old storage policies...');
    await pool.query(`
      DROP POLICY IF EXISTS "Public Read Access" ON storage.objects;
      DROP POLICY IF EXISTS "Public Upload Access" ON storage.objects;
      DROP POLICY IF EXISTS "Public Update Access" ON storage.objects;
      DROP POLICY IF EXISTS "Public Delete Access" ON storage.objects;
    `);
    console.log('Cleaned old policies.');
  } catch (err) {
    console.warn('Could not drop old policies (this is fine if they do not exist):', err);
  }

  // Step 3: Create RLS policies
  try {
    console.log('Creating RLS policies for "verification-documents"...');
    
    // Select policy: Allow anyone to view
    await pool.query(`
      CREATE POLICY "Public Read Access" ON storage.objects
        FOR SELECT
        USING (bucket_id = 'verification-documents');
    `);

    // Insert policy: Allow anyone to upload
    await pool.query(`
      CREATE POLICY "Public Upload Access" ON storage.objects
        FOR INSERT
        WITH CHECK (bucket_id = 'verification-documents');
    `);

    // Update policy: Allow upserts
    await pool.query(`
      CREATE POLICY "Public Update Access" ON storage.objects
        FOR UPDATE
        USING (bucket_id = 'verification-documents');
    `);

    // Delete policy: Allow deletions
    await pool.query(`
      CREATE POLICY "Public Delete Access" ON storage.objects
        FOR DELETE
        USING (bucket_id = 'verification-documents');
    `);

    console.log('RLS Policies successfully configured.');
  } catch (err) {
    console.error('Error setting up RLS policies. You may need to enable these in the Supabase Dashboard -> Storage -> Policies tab.', err);
  }

  await pool.end();
}

main();
