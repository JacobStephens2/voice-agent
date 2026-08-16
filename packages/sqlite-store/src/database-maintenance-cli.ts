import {
  backupSqliteDatabase,
  restoreSqliteDatabase,
  verifyVoiceAgentDatabase,
} from "./database-maintenance.ts";

const [command, sourcePath, destinationPath] = process.argv.slice(2);

if (command === "backup" && sourcePath !== undefined && destinationPath !== undefined) {
  await backupSqliteDatabase(sourcePath, destinationPath);
  process.stdout.write(`Verified SQLite backup written to ${destinationPath}.\n`);
} else if (
  command === "restore" &&
  sourcePath !== undefined &&
  destinationPath !== undefined
) {
  await restoreSqliteDatabase(sourcePath, destinationPath);
  process.stdout.write(`Verified SQLite database restored to ${destinationPath}.\n`);
} else if (command === "verify" && sourcePath !== undefined && destinationPath === undefined) {
  verifyVoiceAgentDatabase(sourcePath);
  process.stdout.write(`SQLite database ${sourcePath} passed integrity and schema checks.\n`);
} else {
  throw new Error(
    "Usage: database-maintenance-cli.ts backup <database> <backup> | restore <backup> <database> | verify <database>",
  );
}
