import React, { useState, useEffect } from 'react';
import { 
  Shield, 
  Upload, 
  Check, 
  FileText, 
  AlertTriangle, 
  Loader, 
  ArrowLeft,
  RefreshCw,
  CheckCircle2,
  Clock,
  XCircle,
  FileCheck
} from 'lucide-react';
import { User } from '../types';
import { uploadVerificationDoc } from '../lib/supabaseClient';

interface IdentityVerificationProps {
  currentUser: User;
  onUpdateUser: (updatedUser: User) => void;
  onCancel: () => void;
}

export interface VerificationDocRecord {
  id: string;
  userId: string;
  documentType: 'GOVERNMENT_ID' | 'DRIVING_LICENSE' | 'VEHICLE_RC' | 'INSURANCE' | 'PROFILE_PHOTO';
  storagePath: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  rejectionReason?: string | null;
  submittedAt: string;
  reviewedAt?: string | null;
  reviewedBy?: string | null;
  history?: any[];
}

const DOC_CONFIGS = [
  { type: 'GOVERNMENT_ID', label: 'Government ID (Aadhaar / Passport)', desc: '12-digit Aadhaar Card or National Identity Document' },
  { type: 'DRIVING_LICENSE', label: 'Driving License', desc: 'Valid Driver’s License for vehicle operation' },
  { type: 'VEHICLE_RC', label: 'Vehicle Registration Certificate (RC)', desc: 'Official Registration Document for your commute vehicle' },
  { type: 'INSURANCE', label: 'Vehicle Insurance Policy', desc: 'Active third-party or comprehensive motor insurance policy' },
  { type: 'PROFILE_PHOTO', label: 'Profile / Selfie Photo', desc: 'Clear front-facing photo for host identity verification' },
] as const;

export default function IdentityVerification({
  currentUser,
  onUpdateUser,
  onCancel
}: IdentityVerificationProps) {
  const [documents, setDocuments] = useState<VerificationDocRecord[]>([]);
  const [overallStatus, setOverallStatus] = useState<'none' | 'pending' | 'verified' | 'action_required'>('none');
  const [loadingDocs, setLoadingDocs] = useState(true);
  
  // Uploading state per doc type e.g. { GOVERNMENT_ID: true }
  const [uploadingState, setUploadingState] = useState<Record<string, boolean>>({});
  const [selectedFiles, setSelectedFiles] = useState<Record<string, File>>({});
  const [error, setError] = useState('');
  const [successMsg, setSuccessMsg] = useState('');

  const fetchDocuments = async () => {
    setLoadingDocs(true);
    try {
      const res = await fetch(`/api/verification/my-documents?userId=${currentUser.id}`);
      if (res.ok) {
        const data = await res.json();
        setDocuments(data.documents || []);
        setOverallStatus(data.overallStatus || 'none');
        
        // Update user state if overall status changed
        if (data.overallStatus === 'verified' && !currentUser.isIdVerified) {
          onUpdateUser({ ...currentUser, isIdVerified: true, verificationStatus: 'verified' });
        }
      }
    } catch {
      setError('Could not fetch verification status.');
    } finally {
      setLoadingDocs(false);
    }
  };

  useEffect(() => {
    fetchDocuments();
    const interval = setInterval(fetchDocuments, 8000);
    return () => clearInterval(interval);
  }, [currentUser.id]);

  const docMap = new Map<string, VerificationDocRecord>(documents.map(d => [d.documentType, d]));

  const handleFileChange = (docType: string, file: File | null) => {
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      setError(`File size for ${docType} exceeds 5MB limit.`);
      return;
    }
    setSelectedFiles(prev => ({ ...prev, [docType]: file }));
  };

  const handleUploadSingleDoc = async (docType: string) => {
    const file = selectedFiles[docType];
    if (!file) {
      setError(`Please select a file for ${docType.replace(/_/g, ' ')} first.`);
      return;
    }

    setError('');
    setSuccessMsg('');
    setUploadingState(prev => ({ ...prev, [docType]: true }));

    try {
      // 1. Upload to Supabase Storage
      const { storagePath, error: uploadErr } = await uploadVerificationDoc(file, currentUser.id, docType);
      
      if (uploadErr || !storagePath) {
        setError(uploadErr || 'Failed to upload document to storage.');
        return;
      }

      // 2. Submit storagePath to MoveBuddy Backend
      const res = await fetch('/api/verification/upload-document', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: currentUser.id,
          documentType: docType,
          storagePath
        })
      });

      const data = await res.json();
      if (!res.ok || !data.success) {
        setError(data.error || 'Failed to save document verification record.');
        return;
      }

      setSuccessMsg(`${docType.replace(/_/g, ' ')} uploaded successfully! Status set to PENDING.`);
      // Clear file selection for this doc
      setSelectedFiles(prev => {
        const copy = { ...prev };
        delete copy[docType];
        return copy;
      });

      await fetchDocuments();
    } catch (err: any) {
      setError(err?.message || 'Upload failed. Please check network connection.');
    } finally {
      setUploadingState(prev => ({ ...prev, [docType]: false }));
    }
  };

  return (
    <div id="verification_flow_main" className="flex flex-col items-center justify-center min-h-[70vh] px-4 py-8 animate-fadeIn">
      
      <div id="doc_verification_card" className="w-full max-w-2xl backdrop-blur-xl border border-white/[0.08] shadow-2xl rounded-2xl p-6 sm:p-8 space-y-6 text-[#F8FAFC]" style={{ backgroundColor: '#1e232a' }}>
        
        {/* Header */}
        <div className="flex flex-col items-center text-center space-y-3 pb-4 border-b border-white/10">
          <div className="relative w-16 h-16 flex items-center justify-center rounded-full bg-[#ff8000]/10 border border-[#ff8000]/20">
            <span className="absolute inset-0 rounded-full bg-[#ff8000]/5 animate-ping duration-[3000ms] opacity-60" />
            <Shield className="w-8 h-8 text-[#ff8000]" />
          </div>
          <div>
            <h2 className="text-xl sm:text-2xl font-display font-black tracking-tight text-white">Host Identity Verification</h2>
            <p className="text-xs mt-1 font-medium text-slate-400">Upload mandatory documents to verify your host profile</p>
          </div>

          {/* Overall Status Banner */}
          <div className="pt-2 w-full">
            {overallStatus === 'verified' && (
              <div className="flex items-center justify-center gap-2 p-3 bg-emerald-500/10 border border-emerald-500/30 rounded-xl text-emerald-400 font-bold text-xs">
                <CheckCircle2 className="w-5 h-5" /> Host Profile Fully Verified & Active
              </div>
            )}
            {overallStatus === 'action_required' && (
              <div className="flex items-center justify-center gap-2 p-3 bg-rose-500/10 border border-rose-500/30 rounded-xl text-rose-400 font-bold text-xs">
                <AlertTriangle className="w-5 h-5" /> Action Required: One or more documents require re-upload
              </div>
            )}
            {overallStatus === 'pending' && (
              <div className="flex items-center justify-center gap-2 p-3 bg-amber-500/10 border border-amber-500/30 rounded-xl text-amber-400 font-bold text-xs">
                <Clock className="w-5 h-5 animate-spin" /> Verification Pending Admin Review
              </div>
            )}
          </div>
        </div>

        {/* Global Notifications */}
        {error && (
          <div className="p-3.5 bg-rose-950/40 text-rose-300 text-xs font-semibold rounded-xl border border-rose-500/20 flex items-start gap-2.5">
            <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
            <p>{error}</p>
          </div>
        )}

        {successMsg && (
          <div className="p-3.5 bg-emerald-950/40 text-emerald-300 text-xs font-semibold rounded-xl border border-emerald-500/20 flex items-start gap-2.5">
            <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
            <p>{successMsg}</p>
          </div>
        )}

        {/* Per-Document Checklist */}
        <div className="space-y-4">
          <h3 className="text-xs font-bold uppercase tracking-widest text-slate-300">Mandatory Verification Checklist (5 Documents)</h3>
          
          {loadingDocs && documents.length === 0 ? (
            <div className="flex items-center justify-center py-8">
              <Loader className="w-6 h-6 text-[#ff8000] animate-spin" />
            </div>
          ) : (
            DOC_CONFIGS.map((cfg, idx) => {
              const rec = docMap.get(cfg.type);
              const isUploading = !!uploadingState[cfg.type];
              const selectedFile = selectedFiles[cfg.type];

              return (
                <div 
                  key={cfg.type} 
                  className={`p-4 rounded-xl border transition-all ${
                    rec?.status === 'APPROVED' 
                      ? 'bg-emerald-950/20 border-emerald-500/30' 
                      : rec?.status === 'REJECTED'
                      ? 'bg-rose-950/20 border-rose-500/40'
                      : rec?.status === 'PENDING'
                      ? 'bg-amber-950/20 border-amber-500/30'
                      : 'bg-slate-900/60 border-white/10'
                  }`}
                >
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                    
                    {/* Left Info */}
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="w-5 h-5 bg-[#ff8000] text-slate-950 text-[10px] font-black rounded-full flex items-center justify-center">
                          {idx + 1}
                        </span>
                        <h4 className="text-xs font-bold text-white">{cfg.label}</h4>
                      </div>
                      <p className="text-[11px] text-slate-400 font-medium pl-7">{cfg.desc}</p>
                    </div>

                    {/* Right Status Badge */}
                    <div className="flex items-center gap-2 shrink-0 self-start sm:self-auto">
                      {rec?.status === 'APPROVED' && (
                        <span className="inline-flex items-center gap-1.5 px-3 py-1 bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 rounded-lg text-[10px] font-bold uppercase tracking-wider">
                          <CheckCircle2 className="w-3.5 h-3.5" /> Approved
                        </span>
                      )}
                      {rec?.status === 'PENDING' && (
                        <span className="inline-flex items-center gap-1.5 px-3 py-1 bg-amber-500/10 text-amber-400 border border-amber-500/30 rounded-lg text-[10px] font-bold uppercase tracking-wider">
                          <Clock className="w-3.5 h-3.5 animate-spin" /> Pending Review
                        </span>
                      )}
                      {rec?.status === 'REJECTED' && (
                        <span className="inline-flex items-center gap-1.5 px-3 py-1 bg-rose-500/10 text-rose-400 border border-rose-500/30 rounded-lg text-[10px] font-bold uppercase tracking-wider">
                          <XCircle className="w-3.5 h-3.5" /> Rejected
                        </span>
                      )}
                      {!rec && (
                        <span className="inline-flex items-center gap-1.5 px-3 py-1 bg-slate-800 text-slate-400 border border-slate-700 rounded-lg text-[10px] font-bold uppercase tracking-wider">
                          Not Uploaded
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Rejection Details & Selective Re-upload */}
                  {rec?.status === 'REJECTED' && rec.rejectionReason && (
                    <div className="mt-3 p-3 bg-rose-950/40 border border-rose-500/30 rounded-lg text-left space-y-1">
                      <span className="text-[10px] font-black uppercase text-rose-400 tracking-wider">Rejection Reason from Admin:</span>
                      <p className="text-xs text-rose-200 font-medium">"{rec.rejectionReason}"</p>
                    </div>
                  )}

                  {/* Upload Controls for Missing or Rejected Documents */}
                  {(!rec || rec.status === 'REJECTED') && (
                    <div className="mt-4 pt-3 border-t border-white/5 space-y-3">
                      <div className="flex flex-col sm:flex-row items-center gap-3">
                        <label className="flex-1 w-full flex items-center justify-center gap-2 p-2.5 bg-slate-900 border border-dashed border-white/20 hover:border-[#ff8000] rounded-xl text-xs font-semibold text-slate-300 cursor-pointer transition">
                          <Upload className="w-4 h-4 text-[#ff8000]" />
                          <span className="line-clamp-1">{selectedFile ? selectedFile.name : `Select ${cfg.label} File`}</span>
                          <input 
                            type="file" 
                            accept="image/*,application/pdf"
                            onChange={e => handleFileChange(cfg.type, e.target.files ? e.target.files[0] : null)}
                            className="hidden" 
                          />
                        </label>

                        {selectedFile && (
                          <button
                            onClick={() => handleUploadSingleDoc(cfg.type)}
                            disabled={isUploading}
                            className="w-full sm:w-auto px-4 py-2.5 bg-[#ff8000] hover:bg-[#e07000] text-slate-950 font-bold text-xs uppercase tracking-wider rounded-xl flex items-center justify-center gap-2 transition disabled:opacity-50"
                          >
                            {isUploading ? <Loader className="w-4 h-4 animate-spin" /> : <FileCheck className="w-4 h-4" />}
                            {isUploading ? 'Uploading...' : 'Upload & Submit'}
                          </button>
                        )}
                      </div>
                    </div>
                  )}

                </div>
              );
            })
          )}
        </div>

        {/* Footer Actions */}
        <div className="flex justify-between items-center pt-4 border-t border-white/10">
          <button
            onClick={onCancel}
            className="px-4 py-2.5 bg-slate-800 hover:bg-slate-700 text-slate-300 font-bold text-xs rounded-xl flex items-center gap-2 transition"
          >
            <ArrowLeft className="w-4 h-4" /> Back to Dashboard
          </button>

          <button
            onClick={fetchDocuments}
            className="px-4 py-2.5 bg-slate-900 hover:bg-slate-800 text-slate-400 hover:text-white font-bold text-xs rounded-xl flex items-center gap-1.5 transition border border-white/5"
          >
            <RefreshCw className="w-3.5 h-3.5" /> Refresh Status
          </button>
        </div>

      </div>
    </div>
  );
}
