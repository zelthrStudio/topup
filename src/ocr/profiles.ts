export interface BankProfile {
  brightness: number;
  contrast: number;
  width: number;
  threshold: number;
}

export interface CropProfile {
  cropTop: number;
  cropBottom: number;
  profile: string;
}

export const PROFILES: Record<string, BankProfile> = {
  default: { brightness: 1.2, contrast: 0.9, width: 1100, threshold: 140 },
  bank_1:  { brightness: 0.8, contrast: 0.5, width: 1200, threshold: 130 },
  bank_3:  { brightness: 0.8, contrast: 0.6, width: 1100, threshold: 130 },
  gsb:     { brightness: 1.29, contrast: 0.69, width: 1265, threshold: 162 },
  gsb_2:   { brightness: 0.8, contrast: 0.5, width: 1200, threshold: 130 },
  gsb_3:   { brightness: 0.8, contrast: 0.9, width: 1100, threshold: 200 },
};

export const CROP_PROFILES: Record<string, CropProfile> = {
  '002': { cropTop: 0, cropBottom: 0, profile: 'default' },
  '004': { cropTop: 0, cropBottom: 0, profile: 'bank_1'  },
  '006': { cropTop: 0, cropBottom: 0, profile: 'default' },
  '011': { cropTop: 0, cropBottom: 0, profile: 'default' },
  '014': { cropTop: 0, cropBottom: 0, profile: 'default' },
  '025': { cropTop: 0, cropBottom: 0, profile: 'default' },
  '030': { cropTop: 0, cropBottom: 0, profile: 'default' },
  '069': { cropTop: 0, cropBottom: 5, profile: 'bank_1'  },
};

export const DEFAULT_CROP: CropProfile = { cropTop: 0, cropBottom: 0, profile: 'default' };