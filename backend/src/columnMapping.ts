/**
 * Monday.com column mapping
 * ----------------------------------------------------------------
 * This file is the single source of truth for how site-visit fields
 * map to Monday board columns. To re-target the integration to a
 * different board:
 *
 *   1. Update SITE_VISITS_BOARD_ID in your environment.
 *   2. Replace the column IDs below with the IDs from the new board.
 *      (Find a column ID in Monday by clicking the column header
 *      arrow > "Customize" > "Edit ID", or via the API
 *      `boards(ids: <BOARD_ID>) { columns { id title type } }`).
 *   3. Restart the backend.
 *
 * Column "type" values match Monday's column types:
 *   text, long_text, date, hour, status, file, board_relation, etc.
 *
 * The "field" name on the left must match the keys produced by the
 * mobile app payload (see mobile/src/types/visit.ts).
 */

export type MondayColumnType =
  | 'text'
  | 'long_text'
  | 'date'
  | 'hour'
  | 'status'
  | 'file';

export interface ColumnMappingEntry {
  /** Field name on the Visit object (camelCase) */
  field: string;
  /** Monday column ID on the master board */
  columnId: string;
  /** Monday column type */
  type: MondayColumnType;
  /** Human label for diagnostics / mock mode */
  label: string;
}

/**
 * Default mapping. Replace `columnId` values with real ones from your
 * board. The IDs below are placeholders that mock mode will accept.
 */
export const COLUMN_MAPPING: ColumnMappingEntry[] = [
  { field: 'clientName',         columnId: 'text_client',        type: 'text',      label: 'Client Name' },
  { field: 'siteName',           columnId: 'text_site',          type: 'text',      label: 'Site Name' },
  { field: 'siteAddress',        columnId: 'long_text_address',  type: 'long_text', label: 'Site Address' },
  { field: 'visitTitle',         columnId: 'text_title',         type: 'text',      label: 'Visit Title' },
  { field: 'visitDate',          columnId: 'date_visit',         type: 'date',      label: 'Visit Date' },
  { field: 'visitStartTime',     columnId: 'hour_start',         type: 'hour',      label: 'Start Time' },
  { field: 'visitEndTime',       columnId: 'hour_end',           type: 'hour',      label: 'End Time' },
  { field: 'consultantName',     columnId: 'text_consultant',    type: 'text',      label: 'Consultant' },
  { field: 'siteContact',        columnId: 'text_site_contact',  type: 'text',      label: 'Site Contact' },
  { field: 'principalContractor',columnId: 'text_principal',     type: 'text',      label: 'Principal Contractor / Project Lead' },
  { field: 'currentWorks',       columnId: 'long_text_works',    type: 'long_text', label: 'Description of Current Works' },
  { field: 'internalNotes',      columnId: 'long_text_notes',    type: 'long_text', label: 'Internal Notes' },
  { field: 'transcript',         columnId: 'long_text_transcript', type: 'long_text', label: 'Transcript' },
  { field: 'uploadStatus',       columnId: 'status_upload',      type: 'status',    label: 'Upload Status' },
  // File columns receive the audio + photos via the file API
  { field: 'audioFile',          columnId: 'file_audio',         type: 'file',      label: 'Audio Recording' },
  { field: 'photoFiles',         columnId: 'file_photos',        type: 'file',      label: 'Site Photos' },
];

/**
 * Item-name field — Monday requires every item to have a name. By default
 * we use the visit title; if missing, we fall back to "<Client> – <Site> (<date>)".
 */
export const ITEM_NAME_FIELD = 'visitTitle';

export function getMapping(field: string): ColumnMappingEntry | undefined {
  return COLUMN_MAPPING.find(c => c.field === field);
}
