import { EventEmitter } from 'events';
import { Knex } from 'knex';
import metricsHelper from '../util/metrics-helper';
import { DB_TIME } from '../metric-events';
import { Logger, LogProvider } from '../logger';
import NotFoundError from '../error/notfound-error';
import { IApiTokenStore } from '../types/stores/api-token-store';
import {
    ApiTokenType,
    IApiToken,
    IApiTokenCreate,
    isAll,
} from '../types/models/api-token';
import { ALL_PROJECTS } from '../util/constants';

const TABLE = 'api_tokens';
const API_LINK_TABLE_PROJECT = 'api_token_project';
const API_LINK_TABLE_ENVIRONMENT = 'api_token_environment';

const ALL = '*';

interface ITokenInsert {
    id: number;
    secret: string;
    username: string;
    type: ApiTokenType;
    expires_at?: Date;
    created_at: Date;
    seen_at?: Date;
}

interface ITokenRow extends ITokenInsert {
    project: string;
    environment: string;
}

const tokenRowReducer = (acc, tokenRow) => {
    const { project, environment, ...token } = tokenRow;
    if (!acc[tokenRow.secret]) {
        acc[tokenRow.secret] = {
            secret: token.secret,
            username: token.username,
            type: token.type,
            project: ALL,
            projects: [ALL],
            environment: ALL,
            environments: [ALL],
            expiresAt: token.expires_at,
            createdAt: token.created_at,
        };
    }
    const currentToken = acc[tokenRow.secret];
    if (tokenRow.project) {
        if (isAll(currentToken.projects)) {
            currentToken.projects = [];
        }
        currentToken.projects.push(tokenRow.project);
        currentToken.project = currentToken.projects.join(',');
    }
    if (tokenRow.environment) {
        if (isAll(currentToken.environments)) {
            currentToken.environments = [];
        }
        currentToken.environments.push(tokenRow.environment);
        currentToken.environment = currentToken.environments.join(',');
    }
    return acc;
};

const toRow = (newToken: IApiTokenCreate) => ({
    username: newToken.username,
    secret: newToken.secret,
    type: newToken.type,
    environment: isAll(newToken.environments)
        ? undefined
        : newToken.environments,
    expires_at: newToken.expiresAt,
});

const toTokens = (rows: any[]): IApiToken[] => {
    const tokens = rows.reduce(tokenRowReducer, {});
    return Object.values(tokens);
};

export class ApiTokenStore implements IApiTokenStore {
    private logger: Logger;

    private timer: Function;

    private db: Knex;

    constructor(db: Knex, eventBus: EventEmitter, getLogger: LogProvider) {
        this.db = db;
        this.logger = getLogger('api-tokens.js');
        this.timer = (action: string) =>
            metricsHelper.wrapTimer(eventBus, DB_TIME, {
                store: 'api-tokens',
                action,
            });
    }

    count(): Promise<number> {
        return this.db(TABLE)
            .count('*')
            .then((res) => Number(res[0].count));
    }

    async getAll(): Promise<IApiToken[]> {
        const stopTimer = this.timer('getAll');
        const rows = await this.makeTokenProjectQuery();
        stopTimer();
        return toTokens(rows);
    }

    async getAllActive(): Promise<IApiToken[]> {
        const stopTimer = this.timer('getAllActive');
        const rows = await this.makeTokenProjectQuery()
            .where('expires_at', 'IS', null)
            .orWhere('expires_at', '>', 'now()');
        stopTimer();
        return toTokens(rows);
    }

    private makeTokenProjectQuery() {
        return this.db<ITokenRow>(`${TABLE} as tokens`)
            .leftJoin(
                `${API_LINK_TABLE_PROJECT} as token_project_link`,
                'tokens.secret',
                'token_project_link.secret',
            )
            .leftJoin(
                `${API_LINK_TABLE_ENVIRONMENT} as token_environment_link`,
                'tokens.secret',
                'token_environment_link.secret',
            )
            .select(
                'tokens.secret',
                'username',
                'type',
                'expires_at',
                'created_at',
                'seen_at',
                'token_project_link.project',
                'token_environment_link.environment',
            );
    }

    async insert(newToken: IApiTokenCreate): Promise<IApiToken> {
        const response = await this.db.transaction(async (tx) => {
            const [row] = await tx<ITokenInsert>(TABLE).insert(
                toRow(newToken),
                ['created_at'],
            );

            const updateProjectTasks = (newToken.projects || [])
                .filter((project) => {
                    return project !== ALL_PROJECTS;
                })
                .map((project) => {
                    return tx.raw(
                        `INSERT INTO ${API_LINK_TABLE_PROJECT} VALUES (?, ?)`,
                        [newToken.secret, project],
                    );
                });
            await Promise.all(updateProjectTasks);
            const updateEnvironmentTasks = (newToken.environments || [])
                .filter((environment) => {
                    return environment !== ALL;
                })
                .map((environment) => {
                    return tx.raw(
                        `INSERT INTO ${API_LINK_TABLE_ENVIRONMENT} VALUES (?, ?)`,
                        [newToken.secret, environment],
                    );
                });
            await Promise.all(updateEnvironmentTasks);
            return {
                ...newToken,
                project: newToken.projects?.join(',') || '*',
                environment: newToken.environments?.join(',') || '*',
                createdAt: row.created_at,
            };
        });
        return response;
    }

    destroy(): void {}

    async exists(secret: string): Promise<boolean> {
        const result = await this.db.raw(
            `SELECT EXISTS (SELECT 1 FROM ${TABLE} WHERE secret = ?) AS present`,
            [secret],
        );
        const { present } = result.rows[0];
        return present;
    }

    async get(key: string): Promise<IApiToken> {
        const row = await this.makeTokenProjectQuery().where('secret', key);
        return toTokens(row)[0];
    }

    async delete(secret: string): Promise<void> {
        return this.db<ITokenRow>(TABLE).where({ secret }).del();
    }

    async deleteAll(): Promise<void> {
        return this.db<ITokenRow>(TABLE).del();
    }

    async setExpiry(secret: string, expiresAt: Date): Promise<IApiToken> {
        const rows = await this.makeTokenProjectQuery()
            .update({ expires_at: expiresAt })
            .where({ secret })
            .returning('*');
        if (rows.length > 0) {
            return toTokens(rows)[0];
        }
        throw new NotFoundError('Could not find api-token.');
    }

    async markSeenAt(secrets: string[]): Promise<void> {
        const now = new Date();
        try {
            await this.db(TABLE)
                .whereIn('secrets', secrets)
                .update({ seen_at: now });
        } catch (err) {
            this.logger.error('Could not update lastSeen, error: ', err);
        }
    }
}
