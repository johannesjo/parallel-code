export type DiffInteractionMode = 'review' | 'ask';

export interface ReviewAnnotation {
  id: string;
  filePath: string;
  startLine: number;
  endLine: number;
  selectedText: string;
  comment: string;
}
