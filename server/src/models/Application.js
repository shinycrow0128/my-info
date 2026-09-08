import mongoose from 'mongoose';
import { PROFILES, STATUSES } from '../config.js';
import { startOfToday } from '../calendarDay.js';

// One stored document - the resume and the cover letter are the same shape, so
// they share a schema rather than drifting apart.
const storedFileSchema = new mongoose.Schema(
  {
    originalName: { type: String, required: true },
    storedName: { type: String, required: true },
    mimeType: { type: String, default: '' },
    size: { type: Number, default: 0 },
    // Plain text pulled out of the .docx so the body is searchable.
    text: { type: String, default: '' },
  },
  { _id: false },
);

const applicationSchema = new mongoose.Schema(
  {
    profileName: { type: String, required: true, enum: PROFILES, index: true },
    jobTitle: { type: String, required: true, trim: true },
    jobLink: { type: String, default: '', trim: true },
    jobDescription: { type: String, default: '' },
    company: { type: String, default: '', trim: true },
    status: { type: String, enum: STATUSES, default: 'applied', index: true },
    // A calendar day pinned to UTC midnight, never the instant the row was
    // written - Date.now() here would stamp an evening bid with tomorrow's date.
    appliedAt: { type: Date, default: startOfToday },
    notes: { type: String, default: '' },
    resume: { type: storedFileSchema, default: null },
    coverLetter: { type: storedFileSchema, default: null },
  },
  { timestamps: true },
);

applicationSchema.index({
  jobTitle: 'text',
  company: 'text',
  jobDescription: 'text',
  'resume.text': 'text',
});

applicationSchema.set('toJSON', {
  virtuals: true,
  versionKey: false,
  transform: (_doc, ret) => {
    ret.id = ret._id.toString();
    delete ret._id;
    return ret;
  },
});

export const Application = mongoose.model('Application', applicationSchema);
