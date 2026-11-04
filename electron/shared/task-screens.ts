/** One captured image of a task's screen. */
export interface ScreenImage {
  /** Absolute path, for opening the file in the system viewer. */
  path: string;
  dataUrl: string;
}

/** One screen of a task, as it looked before the task and as it looks now. */
export interface ScreenShot {
  label: string;
  /** Missing when the screen is new in this task. */
  before?: ScreenImage;
  after: ScreenImage;
}

/** What a capture run of a task's screens returns. */
export interface TaskScreensResult {
  shots: ScreenShot[];
  /** The task's commit when the capture started; later commits make the shots outdated. */
  headSha: string;
  /** Why there are fewer shots than expected, or none. */
  note?: string;
}

/** The commands a capture asks to run, outside Claude's sandbox, to serve each version. */
export interface ServeCommands {
  after: string;
  /** Missing when no screen existed before the task. */
  before?: string;
}
