"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
exports.default = {
    schema: './src/database/schema.ts',
    out: './migrations',
    dialect: 'sqlite',
    dbCredentials: {
        url: process.env.DATABASE_PATH || './data/dev.db',
    },
};
//# sourceMappingURL=drizzle.config.js.map