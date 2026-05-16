import axios from 'axios';
import FormData from 'form-data';
import fs from 'fs';
import { config } from '../config';
import { COLUMN_MAPPING, ITEM_NAME_FIELD, getMapping } from '../columnMapping';

export interface VisitPayload {
  id?: string;
  inspectionReference?: string;
  clientName?: string;
  siteName?: string;
  siteAddress?: string;
  visitTitle?: string;
  visitDate?: string;        // YYYY-MM-DD
  visitStartTime?: string;   // HH:mm
  visitEndTime?: string;     // HH:mm
  consultantName?: string;
  siteContact?: string;
  contractsManager?: string;
  principalContractor?: string;
  currentWorks?: string;
  internalNotes?: string;
  transcript?: string;
  transcriptStatus?: string;
  transcriptError?: string;
  createdAt?: string;
  uploadStatus?: string;     // e.g. "Uploaded"
  photoCount?: number;
  photoFilenames?: string[];
}

export interface UploadFile {
  path: string;
  filename: string;
  mimetype: string;
  /** Which mapped field this file belongs to: "audioFile" | "photoFiles" */
  fieldName: 'audioFile' | 'photoFiles';
}

export interface MondayUploadResult {
  itemId: string;
  uploadedFiles: { fieldName: string; assetId?: string; filename: string }[];
  warnings: string[];
}

/**
 * Build the column_values JSON Monday expects on item creation.
 */
export function buildColumnValues(visit: VisitPayload): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const mapping of COLUMN_MAPPING) {
    if (mapping.type === 'file') continue; // files via file API
    const value = (visit as Record<string, unknown>)[mapping.field];
    if (value === undefined || value === null || value === '') continue;

    switch (mapping.type) {
      case 'text':
        out[mapping.columnId] = String(value);
        break;
      case 'long_text':
        out[mapping.columnId] = { text: String(value) };
        break;
      case 'date': {
        const v = String(value);
        out[mapping.columnId] = { date: v };
        break;
      }
      case 'hour': {
        const v = String(value);
        const [hh, mm] = v.split(':');
        out[mapping.columnId] = { hour: Number(hh) || 0, minute: Number(mm) || 0 };
        break;
      }
      case 'status':
        out[mapping.columnId] = { label: String(value) };
        break;
    }
  }
  return out;
}

function buildItemName(visit: VisitPayload): string {
  const titleField = (visit as Record<string, unknown>)[ITEM_NAME_FIELD];
  if (typeof titleField === 'string' && titleField.trim().length > 0) {
    return titleField.trim();
  }
  const client = visit.clientName?.trim() || 'Unknown client';
  const site = visit.siteName?.trim() || 'Unknown site';
  const date = visit.visitDate?.trim() || new Date().toISOString().slice(0, 10);
  return `${client} – ${site} (${date})`;
}

// ---------------------------------------------------------------------------
// Mock implementation
// ---------------------------------------------------------------------------

let mockItemCounter = 1000;

async function createItemMock(visit: VisitPayload, files: UploadFile[]): Promise<MondayUploadResult> {
  // Pretend network latency
  await new Promise(r => setTimeout(r, 400));
  const itemId = `mock-${++mockItemCounter}`;
  return {
    itemId,
    uploadedFiles: files.map(f => ({
      fieldName: f.fieldName,
      assetId: `mock-asset-${Math.random().toString(36).slice(2, 8)}`,
      filename: f.filename,
    })),
    warnings: [
      `Mock mode: did not contact Monday. Item "${buildItemName(visit)}" simulated as ${itemId}.`,
    ],
  };
}

// ---------------------------------------------------------------------------
// Real Monday API calls
// ---------------------------------------------------------------------------

async function mondayGraphQL<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await axios.post(
    config.monday.apiUrl,
    { query, variables },
    {
      headers: {
        Authorization: config.monday.apiToken,
        'API-Version': config.monday.apiVersion,
        'Content-Type': 'application/json',
      },
      timeout: 30_000,
    }
  );
  if (res.data.errors) {
    throw new Error(`Monday API error: ${JSON.stringify(res.data.errors)}`);
  }
  return res.data.data as T;
}

async function uploadFileToItem(
  itemId: string,
  columnId: string,
  file: UploadFile
): Promise<string | undefined> {
  const form = new FormData();
  const query = `mutation ($file: File!) {
    add_file_to_column(item_id: ${itemId}, column_id: "${columnId}", file: $file) {
      id
    }
  }`;
  form.append('query', query);
  form.append('variables[file]', fs.createReadStream(file.path), {
    filename: file.filename,
    contentType: file.mimetype,
  });

  const res = await axios.post(config.monday.fileUrl, form, {
    headers: {
      ...form.getHeaders(),
      Authorization: config.monday.apiToken,
      'API-Version': config.monday.apiVersion,
    },
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
    timeout: 120_000,
  });
  if (res.data.errors) {
    throw new Error(`Monday file upload error: ${JSON.stringify(res.data.errors)}`);
  }
  return res.data?.data?.add_file_to_column?.id;
}

async function createItemReal(visit: VisitPayload, files: UploadFile[]): Promise<MondayUploadResult> {
  if (!config.monday.boardId) throw new Error('SITE_VISITS_BOARD_ID is not configured');
  if (!config.monday.apiToken) throw new Error('MONDAY_API_TOKEN is not configured');

  const itemName = buildItemName(visit);
  const columnValues = buildColumnValues(visit);

  const createQuery = `mutation ($boardId: ID!, $itemName: String!, $columnValues: JSON!) {
    create_item(board_id: $boardId, item_name: $itemName, column_values: $columnValues) {
      id
    }
  }`;
  const created = await mondayGraphQL<{ create_item: { id: string } }>(createQuery, {
    boardId: config.monday.boardId,
    itemName,
    columnValues: JSON.stringify(columnValues),
  });
  const itemId = created.create_item.id;

  const uploadedFiles: MondayUploadResult['uploadedFiles'] = [];
  const warnings: string[] = [];

  for (const f of files) {
    const mapping = getMapping(f.fieldName);
    if (!mapping) {
      warnings.push(`Skipping ${f.filename}: no mapping for field ${f.fieldName}`);
      continue;
    }
    try {
      const assetId = await uploadFileToItem(itemId, mapping.columnId, f);
      uploadedFiles.push({ fieldName: f.fieldName, assetId, filename: f.filename });
    } catch (err) {
      warnings.push(
        `File upload failed for ${f.filename}: ${(err as Error).message}. Item was created; retry upload.`
      );
    }
  }

  return { itemId, uploadedFiles, warnings };
}

// ---------------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------------

export async function uploadVisitToMonday(
  visit: VisitPayload,
  files: UploadFile[]
): Promise<MondayUploadResult> {
  if (config.mockMode) return createItemMock(visit, files);
  return createItemReal(visit, files);
}
