import type { DoctorCheck } from "./types.js";
import type { CampStore } from "./store.js";
export declare function runDoctor(store: CampStore): Promise<DoctorCheck[]>;
