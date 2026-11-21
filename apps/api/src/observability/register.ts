// Loaded first with `node --import`, so the SDK patches libraries before the application imports them.
import { startTelemetry } from './otel.js';

startTelemetry(process.env);
