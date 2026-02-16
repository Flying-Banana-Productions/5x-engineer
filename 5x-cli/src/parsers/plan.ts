export interface ParsedPlan {
  title: string;
  version: string;
  status: string;
  phases: Phase[];
  currentPhase: Phase | null;
  completionPercentage: number;
}

export interface Phase {
  number: number;
  title: string;
  heading: string;
  completionGate?: string;
  items: ChecklistItem[];
  isComplete: boolean;
  line: number;
}

export interface ChecklistItem {
  text: string;
  checked: boolean;
  line: number;
}

const PHASE_HEADING_RE = /^(#{2,3})\s+Phase\s+(\d+(?:\.\d+)?)[:\s]+(.+)$/;
const CHECKLIST_RE = /^-\s+\[([ xX])\]\s+(.+)$/;
const METADATA_RE = /^\*\*(\w[\w\s]*):\*\*\s*(.+)$/;
const COMPLETION_GATE_RE = /^\*\*Completion gate:\*\*\s*(.+)$/;
const COMPLETE_SUFFIX_RE = /\s*[-–—]\s*COMPLETE\s*$/i;

export function parsePlan(markdown: string): ParsedPlan {
  const lines = markdown.split("\n");

  // Extract metadata from early lines
  let title = "";
  let version = "";
  let status = "";

  // Title is first # heading
  for (const line of lines) {
    const titleMatch = line.match(/^#\s+(.+)$/);
    if (titleMatch) {
      title = titleMatch[1]!.trim();
      break;
    }
  }

  for (const line of lines) {
    const metaMatch = line.match(METADATA_RE);
    if (metaMatch) {
      const key = metaMatch[1]!.trim().toLowerCase();
      const value = metaMatch[2]!.trim();
      if (key === "version") version = value;
      if (key === "status") status = value;
    }
  }

  // Parse phases
  const phases: Phase[] = [];
  let currentPhaseIdx = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineNum = i + 1;

    // Check for phase heading
    const phaseMatch = line.match(PHASE_HEADING_RE);
    if (phaseMatch) {
      const rawTitle = phaseMatch[3]!.trim();
      const isMarkedComplete = COMPLETE_SUFFIX_RE.test(rawTitle);
      const cleanTitle = rawTitle.replace(COMPLETE_SUFFIX_RE, "").trim();

      const phase: Phase = {
        number: parseFloat(phaseMatch[2]!),
        title: cleanTitle,
        heading: line,
        items: [],
        isComplete: isMarkedComplete,
        line: lineNum,
      };
      phases.push(phase);
      currentPhaseIdx = phases.length - 1;
      continue;
    }

    // Check for completion gate (within a phase)
    if (currentPhaseIdx >= 0) {
      const gateMatch = line.match(COMPLETION_GATE_RE);
      if (gateMatch) {
        phases[currentPhaseIdx]!.completionGate = gateMatch[1]!.trim();
        continue;
      }
    }

    // Check for checklist items (within a phase)
    if (currentPhaseIdx >= 0) {
      const checkMatch = line.match(CHECKLIST_RE);
      if (checkMatch) {
        phases[currentPhaseIdx]!.items.push({
          text: checkMatch[2]!.trim(),
          checked: checkMatch[1] !== " ",
          line: lineNum,
        });
      }
    }

    // If we hit a heading that's NOT a sub-section of the current phase,
    // and it's at the same or higher level as Phase headings, close the phase
    if (currentPhaseIdx >= 0 && /^#{1,2}\s+/.test(line) && !phaseMatch) {
      // Only close if it's a ## or # heading (not ### which are sub-sections)
      if (/^#{1,2}\s+[^#]/.test(line) && !PHASE_HEADING_RE.test(line)) {
        currentPhaseIdx = -1;
      }
    }
  }

  // Determine phase completion from checklist items
  for (const phase of phases) {
    if (phase.items.length > 0 && !phase.isComplete) {
      phase.isComplete = phase.items.every((item) => item.checked);
    }
  }

  // Find current phase (first incomplete)
  const currentPhase = phases.find((p) => !p.isComplete) ?? null;

  // Calculate overall completion
  const totalItems = phases.reduce((sum, p) => sum + p.items.length, 0);
  const checkedItems = phases.reduce(
    (sum, p) => sum + p.items.filter((i) => i.checked).length,
    0
  );
  const completionPercentage = totalItems > 0 ? Math.round((checkedItems / totalItems) * 100) : 0;

  return {
    title,
    version,
    status,
    phases,
    currentPhase,
    completionPercentage,
  };
}
