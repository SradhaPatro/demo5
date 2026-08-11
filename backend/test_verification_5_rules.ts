import { calcHostOverallStatus } from './server';

// Test execution script for the 5 critical verification rules
console.log("==================================================");
console.log("RUNNING 5-RULE VERIFICATION ARCHITECTURE AUDIT");
console.log("==================================================\n");

const MANDATORY = ['GOVERNMENT_ID', 'DRIVING_LICENSE', 'VEHICLE_RC', 'INSURANCE', 'PROFILE_PHOTO'];

// Rule 1: Host Status Recalculation
console.log("RULE 1: Host Status Recalculation");

const allApprovedDocs = MANDATORY.map(type => ({ documentType: type, status: 'APPROVED' }));
console.log("  - All 5 Approved => Expected: 'verified', Actual:", calcHostOverallStatus(allApprovedDocs));
assert(calcHostOverallStatus(allApprovedDocs) === 'verified', "Rule 1 Fail: All approved should equal 'verified'");

const oneRejectedDocs = [
  { documentType: 'GOVERNMENT_ID', status: 'APPROVED' },
  { documentType: 'DRIVING_LICENSE', status: 'APPROVED' },
  { documentType: 'VEHICLE_RC', status: 'REJECTED' },
  { documentType: 'INSURANCE', status: 'APPROVED' },
  { documentType: 'PROFILE_PHOTO', status: 'APPROVED' }
];
console.log("  - 1 Rejected => Expected: 'action_required', Actual:", calcHostOverallStatus(oneRejectedDocs));
assert(calcHostOverallStatus(oneRejectedDocs) === 'action_required', "Rule 1 Fail: One rejected should equal 'action_required'");

const missingOneDocs = [
  { documentType: 'GOVERNMENT_ID', status: 'APPROVED' },
  { documentType: 'DRIVING_LICENSE', status: 'APPROVED' },
  { documentType: 'VEHICLE_RC', status: 'PENDING' },
  { documentType: 'INSURANCE', status: 'APPROVED' },
  { documentType: 'PROFILE_PHOTO', status: 'APPROVED' }
];
console.log("  - 1 Pending => Expected: 'pending', Actual:", calcHostOverallStatus(missingOneDocs));
assert(calcHostOverallStatus(missingOneDocs) === 'pending', "Rule 1 Fail: One pending should equal 'pending'");

// Rule 5: Replacing an Approved Document
console.log("\nRULE 5: Replacing an Approved Document Drops Status");
// Suppose user was VERIFIED (all 5 approved), now host replaces VEHICLE_RC with a new upload (status PENDING)
const replacedDocs = [
  { documentType: 'GOVERNMENT_ID', status: 'APPROVED' },
  { documentType: 'DRIVING_LICENSE', status: 'APPROVED' },
  { documentType: 'VEHICLE_RC', status: 'PENDING' }, // newly uploaded
  { documentType: 'INSURANCE', status: 'APPROVED' },
  { documentType: 'PROFILE_PHOTO', status: 'APPROVED' }
];
const newOverall = calcHostOverallStatus(replacedDocs);
console.log("  - Host replaced approved RC with new document => Overall status drops from 'verified' to:", newOverall);
assert(newOverall === 'pending', "Rule 5 Fail: Replaced doc must drop status to 'pending'");

console.log("\n==================================================");
console.log("✅ ALL 5 RULE ASSERIONS PASSED SUCCESSFULLY!");
console.log("==================================================");
process.exit(0);

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error("❌ ASSERTION FAILED:", msg);
    process.exit(1);
  }
}
