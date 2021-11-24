import assert from 'assert';
import path from 'path';
import readline from 'readline';
import eachSeries from 'p-each-series';
import { pEvent as fromEvent } from 'p-event';
import { dirname } from 'dirname-filename-esm';

import { mockCwd } from 'mock-cwd';

import getClient from '../lib/clients/index.js'; // eslint-disable-line import/extensions
import { parse } from '../lib/command-line-options.js'; // eslint-disable-line import/extensions
import { run } from '../lib/postgrator-cli.js'; // eslint-disable-line import/extensions

const __dirname = dirname(import.meta); // eslint-disable-line no-underscore-dangle

const MAX_REVISION = 5;
const originalConsoleLog = console.log;

const tests = [];

let log = '';

function consoleLogCapture(...args) {
    log += [].slice.call(args);
}

async function removeVersionTable(options) {
    const config = {
        migrationPattern: options['migration-pattern'],
        driver: options.driver,
        host: options.host,
        port: options.port,
        database: options.database,
        username: options.username,
        password: options.password,
        ssl: options.ssl,
    };
    console.log(`\n----- ${config.driver} removing tables -----`);
    const { default: Postgrator } = await import('postgrator');
    const client = await getClient(config.driver, config);
    await client.connect();
    const pg = new Postgrator({
        ...config,
        execQuery: client.query,
    });

    return pg.runQuery('DROP TABLE IF EXISTS schemaversion, animal, person').then(() => client.end()).catch((err) => {
        assert.ifError(err);
        return Promise.reject(err);
    });
}

function getDefaultOptions() {
    return parse({ partial: true });
}

/* Build a set of tests for a given config.
   This will be helpful when we want to run the same kinds of tests on
   postgres, mysql, sql server, etc.
============================================================================= */
function buildTestsForOptions(options) {
    const originalOptions = JSON.parse(JSON.stringify(options));

    function restoreOptions() {
        options = JSON.parse(JSON.stringify(originalOptions));
    }

    async function resetMigrations() {
        console.log('\n----- Reset migrations-----');
        const originalTo = options.to;
        options.to = 0;
        await run(options);
        options.to = originalTo;
    }

    tests.push(() => removeVersionTable(options).catch((err) => {
        assert.ifError(err);
        return Promise.resolve();
    }));

    tests.push(async () => {
        console.log('\n----- testing show help (output suppressed)-----');
        options.help = true;

        console.log = consoleLogCapture;
        const migrations = await run(options);
        console.log = originalConsoleLog;
        restoreOptions();
        assert.strictEqual(migrations, undefined);
        assert.ok(log.indexOf('Examples') >= 0, 'No help was displayed');
    });

    tests.push(async () => {
        console.log('\n----- testing show version (output suppressed)-----');
        options.version = true;

        console.log = consoleLogCapture;
        const migrations = await run(options);
        console.log = originalConsoleLog;
        restoreOptions();
        assert.strictEqual(migrations, undefined);
        assert.ok(log.indexOf('Version: ') >= 0, 'No version was displayed');
    });

    tests.push(async () => {
        console.log('\n----- testing migration to 003 -----');
        const migrations = await run(options);
        assert.equal(migrations.length, 3);
        assert.equal(migrations[2].version, 3);
    });

    tests.push(async () => {
        console.log('\n----- testing migration to 000 with conflict detection-----');
        options.to = 0;

        const migrations = await run(options);
        restoreOptions();
        assert.equal(migrations.length, 3);
        assert.equal(migrations[2].version, 1);
        assert.equal(migrations[2].action, 'undo');
    });

    tests.push(async () => {
        console.log('\n----- testing migration to 001 -----');
        options.to = 1;
        const migrations = await run(options);
        restoreOptions();
        assert.equal(migrations.length, 1);
        assert.equal(migrations[0].version, 1);
        assert.equal(migrations[0].action, 'do');
    });

    tests.push(() => {
        console.log('\n----- testing migration from 001 to 003 using config file -----');
        options.to = '0003';
        options.username = '';
        options.database = '';

        return mockCwd(path.join(__dirname, 'sample-config'), async () => {
            const migrations = await run(options);
            restoreOptions();
            assert.equal(migrations[migrations.length - 1].version, 3);
        });
    });

    tests.push(() => {
        console.log('\n----- testing migration from 003 to 002 using config file -----');
        options.to = '02';
        options.username = '';
        options.database = '';

        return mockCwd(path.join(__dirname, 'sample-config'), async () => {
            const migrations = await run(options);
            restoreOptions();
            assert.equal(migrations[0].version, 3);
            assert.equal(migrations[0].action, 'undo');
        });
    });

    tests.push(resetMigrations);

    tests.push(async () => {
        console.log('\n----- testing using latest revision without specifying to-----');
        options.to = getDefaultOptions().to; // is 'max'

        const migrations = await run(options);
        restoreOptions();
        assert.equal(migrations.length, MAX_REVISION);
        assert.equal(migrations[migrations.length - 1].version, MAX_REVISION);
    });

    tests.push(() => {
        console.log('\n----- testing it does not re-apply same migrations -----');
        options.password = '';
        options.to = '';

        return mockCwd(path.join(__dirname, 'sample-config'), async () => {
            const migrations = await run(options);
            restoreOptions();
            assert.equal(migrations.length, 0); // returns number of applied migrations
        });
    });

    tests.push(async () => {
        console.log('\n----- testing with no migration files found-----');
        options.to = 3;
        options['migration-pattern'] = 'test/empty-migrations/*';

        console.log = consoleLogCapture;
        try {
            await run(options);
        } catch (err) {
            console.log = originalConsoleLog;
            restoreOptions();
            assert(err, 'No error when there should be');
            assert(err.message.indexOf('No migration files found') >= 0);
            assert(log.indexOf('Examples') < 0, "Help was displayed when shouldn't");
        }
    });

    tests.push(resetMigrations);

    tests.push(() => {
        console.log('\n----- testing ignoring config file -----');
        options['migration-pattern'] = '../migrations/*';
        options['no-config'] = true;
        options.to = 'max';

        return mockCwd(path.join(__dirname, 'config-with-non-existing-directory'), async () => {
            const migrations = await run(options);
            restoreOptions();
            assert.equal(migrations.length, MAX_REVISION);
            assert.equal(migrations[migrations.length - 1].version, MAX_REVISION);
        });
    });

    tests.push(resetMigrations);

    tests.push(() => {
        console.log('\n----- testing with alternative migration directory set in config file-----');
        options.to = 'max';
        options.username = '';
        options.database = '';

        return mockCwd(path.join(__dirname, 'config-with-other-directory'), async () => {
            const migrations = await run(options);
            assert(migrations.length, 2);
            await resetMigrations();
            restoreOptions();
        });
    });

    tests.push(async () => {
        console.log('\n----- testing empty password-----');
        options.password = '';

        run(options);
        // this error is not thrown down the chain so it cannot be caught
        const err = await fromEvent(process, 'unhandledRejection');
        assert(err, 'ERR_INVALID_ARG_TYPE');
        restoreOptions();
    });

    tests.push(async () => {
        console.log('\n----- testing null password asks from user-----');

        let passwordAsked = false;
        options.password = null;

        // mock readline
        const originalCreateInterface = readline.createInterface;
        readline.createInterface = () => {
            return {
                question: (_questionTest, cb) => { passwordAsked = true; cb('myPassword'); }, // invalid password
                history: { slice: () => {} },
                close: () => {},
            };
        };

        return run(options).catch((err) => {
            restoreOptions();
            assert(passwordAsked);
            assert(err.length > 0);
            readline.createInterface = originalCreateInterface;
        });
    });

    tests.push(() => {
        console.log('\n----- testing that config file without password asks from user -----');
        options.to = 'max';
        options.username = '';
        options.database = '';
        let passwordAsked = false;

        // mock readline
        const originalCreateInterface = readline.createInterface;
        readline.createInterface = () => {
            return {
                question: (_questionTest, cb) => { passwordAsked = true; cb('postgrator'); }, // correct password
                history: { slice: () => {} },
                close: () => {},
            };
        };

        return mockCwd(path.join(__dirname, 'config-without-password'), async () => {
            const migrations = await run(options);
            assert(migrations.length);
            assert(passwordAsked);
            await resetMigrations();
            readline.createInterface = originalCreateInterface;
            restoreOptions();
        });
    });

    tests.push(() => {
        console.log('\n----- testing detecting migration files with same number-----');
        options.to = 3;
        options['migration-pattern'] = 'test/conflicting-migrations/*';

        return run(options).catch((err) => {
            restoreOptions();
            assert(err.message.indexOf('Two migrations found with version 2 and action do') >= 0, 'No migration conflicts were detected');
        });
    });

    tests.push(() => removeVersionTable({
        ...options,
        driver: 'mysql',
        port: 3306,
    }));

    tests.push(async () => {
        console.log('\n----- testing migration to 003 using mysql -----');

        return mockCwd(path.join(__dirname, 'mysql-config'), async () => {
            const migrations = await run(options);
            assert.equal(migrations.length, 3);
            assert.equal(migrations[2].version, 3);
        });
    });

    tests.push(() => removeVersionTable({
        ...options,
        driver: 'mssql',
        port: 1433,
        database: 'master',
        username: 'sa',
        password: 'Postgrator123!',
        ssl: false,
    }));

    tests.push(async () => {
        console.log('\n----- testing migration to 003 using mssql -----');

        return mockCwd(path.join(__dirname, 'mssql-config'), async () => {
            const migrations = await run(options);
            assert.equal(migrations.length, 3);
            assert.equal(migrations[2].version, 3);
        });
    });
}

const options = {
    to: 3,
    driver: 'pg',
    host: '127.0.0.1',
    port: '5432',
    database: 'postgrator',
    username: 'postgrator',
    password: 'postgrator',
    'migration-pattern': 'test/migrations/*',
    'schema-table': 'schemaversion',
    'validate-checksum': true,
};

// Command line parameters
buildTestsForOptions(options);

// Run the tests
console.log(`Running ${tests.length} tests`);
eachSeries(tests, (testFunc) => {
    console.log = originalConsoleLog;
    log = '';
    return testFunc();
}).then(() => {
    console.log('\nIt works!');
    process.exit(0);
}).catch((err) => {
    console.log = originalConsoleLog;
    console.log(err);
    assert.ifError(err);
});
