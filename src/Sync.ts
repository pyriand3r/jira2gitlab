import * as JiraApi from "jira-client";
import * as gitlab from "node-gitlab";
import * as _ from "underscore";
import * as request from "request-promise";
import * as path from 'path';
import {execSync} from 'child_process';
import * as fs from 'fs';
import * as winston from "winston";

/**
 * @interface IssueMapping
 */
export interface IssueMapping {
    jira: string;
    gitlab: string;
    field: string;
    filter: [
        string
        ],
    prefix: string;
}

/**
 * @interface UserMapping
 */
export interface UserMapping {
    jiraMail: string;
    gitlabUsername: string;
}

/**
 * @interface SyncOptions
 */
export interface SyncOptions {
    simulation: boolean,
    logger: {
        level: string;
        toFile: boolean;
        file: string;
    }
    jira: {
        host: string;
        protocol?: string;
        username: string;
        password?: string;
        projectKey: string;
        strictSSL?: boolean;
    };
    gitlab: {
        url: string;
        privateToken?: string;
        namespace: string;
        projectName: string;
        timeout: number;
    };
    issueMapping: IssueMapping[];
    userMapping: UserMapping[];
    general: {
        worklog: boolean;
        estimatedTime: boolean;
        backlink: boolean;
        asOriginalAuthor: boolean;
        comments: boolean;
        attachments: boolean;
        syncField: boolean;
        ignoreIssues: {
            closed: boolean;
            date: boolean;
            dateConfig: {
                date: string;
                type: string;
            }
        }
    };
}

/**
 * @class Sync
 */
export class Sync {

    private gitlabProjectMembers: any[];
    private gitlabProject: any;
    private gitlabJiraField: any;
    private jiraClient: any;
    private gitlabClient: any;
    private baseLink: string;

    /**
     * @constructor
     * @param {SyncOptions} options
     */
    constructor(private options: SyncOptions) {
        let proto = this.options.jira.protocol ? this.options.jira.protocol : "https";
        this.baseLink = proto + '://' + options.jira.host;
        if (this.baseLink.endsWith('/')) {
            this.baseLink = this.baseLink.substring(0, this.baseLink.length - 1);
        }
    }

    /**
     * @method doTheDance
     * Perform the complete import
     *
     * @async
     * @returns {Promise<void>}
     */
    public async doTheDance(): Promise<void> {
        return new Promise<void>(async () => {
            const protocol: string = this.options.jira.protocol ? this.options.jira.protocol : "https";
            const strictSSL: boolean = this.options.jira.strictSSL ? this.options.jira.strictSSL : false;
            // const jql: string = encodeURIComponent(`project=${this.options.jira.projectKey}`);

            this.jiraClient = new JiraApi({
                protocol,
                host: this.options.jira.host,
                username: this.options.jira.username,
                password: this.options.jira.password,
                apiVersion: '2',
                strictSSL
            });

            // create jira custom field for syncing already created issues
            if (this.options.general.syncField === true) {
                const jiraFields = await this.jiraClient.listFields();
                const customJiraFieldName: string = "jira2gitlab";
                this.gitlabJiraField = _.find(jiraFields, (jiraField) => jiraField.name === customJiraFieldName);


                if (this.gitlabJiraField === undefined) {
                    winston.info("Creating custom jira field : " + customJiraFieldName);
                    if (!this.options.simulation) {
                        this.gitlabJiraField = await this.jiraClient.createCustomField({
                            "name": customJiraFieldName,
                            "description": "Custom field for keeping track of already synced issues",
                            "type": "com.atlassian.jira.plugin.system.customfieldtypes:textfield"
                        });
                        await request({
                            url: protocol + "://" + this.options.jira.host + "/rest/api/2/screens/addToDefault/" + this.gitlabJiraField.id,
                            method: "post",
                            auth: {
                                username: this.options.jira.username,
                                password: this.options.jira.password
                            }
                        });
                    }
                }
            }

            let options = {
                api: `${this.options.gitlab.url}/api/v3`,
                privateToken: this.options.gitlab.privateToken,
                requestTimeout: 5000
            };

            if (this.options.gitlab.timeout !== undefined) {
                options.requestTimeout = this.options.gitlab.timeout
            }

            this.gitlabClient = gitlab.createPromise(options);

            winston.info(`Getting gitlab project ${this.options.gitlab.namespace}/${this.options.gitlab.projectName}`);
            const gitlabProjectId: string = this.options.gitlab.namespace + "%2F" + this.options.gitlab.projectName;
            this.gitlabProject = await this.gitlabClient.projects.get({id: gitlabProjectId});
            if (this.gitlabProject === undefined)
                throw new Error("Could not find gitlab project " + this.options.gitlab.namespace + "/" + this.options.gitlab.projectName);


            winston.info(`Getting gitlab project members...`);
            this.gitlabProjectMembers = await this.gitlabClient.projectMembers.list({id: this.gitlabProject.id});

            winston.info('Getting gitlab project shared groups members...');
            for (let i = 0; i < this.gitlabProject.shared_with_groups.length; i++) {
                try {
                    const groupMembers = await request.get(this.options.gitlab.url + "/api/v3/groups/" + this.gitlabProject.shared_with_groups[i].group_id + "/members", {
                        headers: {"PRIVATE-TOKEN": this.options.gitlab.privateToken},
                        json: true
                    });
                    this.gitlabProjectMembers = this.gitlabProjectMembers.concat(groupMembers);
                } catch (err) {
                    winston.error('ERROR: ' + err.message);
                }
            }

            winston.info(`Getting gitlab namespace members...`);
            try {
                const gitlabGroupMembers = await request.get(this.options.gitlab.url + "/api/v3/groups/" + this.gitlabProject.namespace.id + "/members", {
                    headers: {"PRIVATE-TOKEN": this.options.gitlab.privateToken},
                    json: true
                });
                this.gitlabProjectMembers = this.gitlabProjectMembers.concat(gitlabGroupMembers);
            } catch (e) {
                winston.info("Error: " + e.message);
            }

            winston.info(`Matching issues...`);

            let startAt: number = 0;
            let maxResults: number = 50;
            let total: number;
            do {
                winston.info("Querying Jira, startAt:" + startAt + ", pageSize:" + maxResults);
                const jiraIssues: any = await this.jiraClient.searchJira(`project=${this.options.jira.projectKey}`, {
                    startAt,
                    maxResults
                });
                if (total === undefined) {
                    total = jiraIssues.total;
                    winston.info("  => total size is " + total);
                }
                startAt += maxResults;
                await this.matchIssues(jiraIssues.issues);
            } while ((startAt < total));
        });
    }

    /**
     * @method matchIssues
     *
     * @async
     * @param {any[]} jiraIssues
     * @returns {Promise<void>}
     */
    private async matchIssues(jiraIssues: any[]): Promise<void> {
        return new Promise<void>(async (resolve) => {
            for (const issue of jiraIssues) {
                winston.info('########################################');
                let jiraIssue: any = await this.jiraClient.findIssue(issue.id);

                if (this.options.general.ignoreIssues !== undefined && this.checkIgnoreIssue(jiraIssue) === true) {
                    winston.info('Ignoring issue due to filter settings in ignoreIssues field');
                    continue;
                }

                let gitlabIssueJSON: any = {};
                winston.info("Syncing issue: " + jiraIssue.key);
                for (const issueMapping of this.options.issueMapping) {
                    if (Sync.resolveAttribute(jiraIssue, issueMapping.jira) === undefined) {
                        winston.warn("WARNING: skipping field mapping for '" + issueMapping.jira + "' since it doesn't exist on jira issue...");
                        continue;
                    }
                    winston.info(`Jira -> ${issueMapping.jira} to Gitlab -> ${issueMapping.gitlab}`);
                    if (issueMapping.gitlab.startsWith("$")) {
                        gitlabIssueJSON = this.resolveMappingMacros(jiraIssue, issueMapping, gitlabIssueJSON)
                    }
                    else {
                        winston.info("  => Value: " + Sync.resolveAttribute(jiraIssue, issueMapping.jira));
                        gitlabIssueJSON[issueMapping.gitlab] = Sync.resolveAttribute(jiraIssue, issueMapping.jira);
                    }
                }

                // assignee
                if (jiraIssue.fields.assignee) {
                    winston.info("Mapping jira assignee " + jiraIssue.fields.assignee.emailAddress);
                    let gitlabUser = this.jira2gitlabUser(jiraIssue.fields.assignee.emailAddress);
                    if (gitlabUser !== false) {
                        gitlabIssueJSON.assignee_id = gitlabUser.id;
                    }
                }

                gitlabIssueJSON.id = this.gitlabProject.id;
                if (!this.options.simulation) {

                    if (this.options.general.asOriginalAuthor === true) {
                        winston.info("Mapping jira author " + jiraIssue.fields.creator.emailAddress);
                        let gitlabUser = this.jira2gitlabUser(jiraIssue.fields.creator.emailAddress);
                        if (gitlabUser !== false) {
                            this.gitlabClient.addHeader('SUDO', gitlabUser.username)
                        }
                    }

                    let attachments = [];
                    if (this.options.general.attachments === true) {
                        winston.info('  => Applying attachments');
                        attachments = await this.applyAttachments(jiraIssue, this.gitlabProject.id);
                    }

                    if ('description' in gitlabIssueJSON && gitlabIssueJSON.description !== null) {
                        gitlabIssueJSON.description = Sync.replaceAttachmentLinks(gitlabIssueJSON.description, attachments);
                        gitlabIssueJSON.description = Sync.transformSyntax(gitlabIssueJSON.description);
                    }

                    let gitlabIssue: any;
                    let createNewIssue: boolean = true;

                    if (this.options.general.syncField === true) {
                        let syncField = Sync.resolveAttribute(jiraIssue, "fields." + this.gitlabJiraField.id);
                        if (syncField !== null) {
                            winston.info("Updating gitlab issue " + syncField);
                            gitlabIssueJSON.issue_id = syncField;
                            try {
                                gitlabIssue = await this.gitlabClient.issues.update(_.clone(gitlabIssueJSON));
                                this.gitlabClient.removeHeader('SUDO');
                                createNewIssue = false;
                            } catch (e) {
                                winston.info("The Gitlab issue, which was referenced on the Jira issue (#" + syncField + "), could not be found, creating / linking new one!");
                                gitlabIssueJSON.issue_id = undefined;
                            }

                        }
                    }
                    if (createNewIssue) {
                        winston.info("Creating new gitlab issue!");
                        gitlabIssue = await this.gitlabClient.issues.create(gitlabIssueJSON);
                        this.gitlabClient.removeHeader('SUDO');
                        // time spent and estimated
                        if (this.options.general.worklog === true
                            || this.options.general.estimatedTime === true) {
                            this.applyTimeLog(jiraIssue, gitlabIssue);
                        }
                        // adding backlink as comment
                        if (this.options.general.backlink === true) {
                            winston.info('  => Applying backlink to jira');
                            try {
                                await this.gitlabClient.issues.createNote({
                                    id: gitlabIssue.project_id,
                                    issue_id: gitlabIssue.id,
                                    body: 'Imported from jira. Original issue: ' + this.baseLink + '/browse/' + jiraIssue.key
                                });
                            } catch (e) {
                                winston.error("ERROR: Adding of backlink as comment failed: ", e);
                            }
                        }

                        // If there are attachments add a comment containing them all
                        // Necessary if there are attachments not referenced in a comment
                        if (attachments.length > 0) {
                            winston.info('  => Adding comment with all attachments.');
                            let body = 'Attachments applied from jira ticket:';

                            for (let item in attachments) {
                                if (attachments.hasOwnProperty(item)) {
                                    body += '<br/>' + attachments[item].markdown;
                                }
                            }
                            try {
                                await this.gitlabClient.issues.createNote({
                                    id: gitlabIssue.project_id,
                                    issue_id: gitlabIssue.id,
                                    body: body
                                })
                            } catch (err) {
                                winston.error('ERROR: Attachment comment could not be set.', err)
                            }
                        }

                        // adding comments if needed
                        if (this.options.general.comments === true) {
                            winston.info('  => adding ' + jiraIssue.fields.comment.comments.length + ' comments');
                            for (let i = 0; i < jiraIssue.fields.comment.comments.length; i++) {
                                let comment = jiraIssue.fields.comment.comments[i];
                                let author = this.jira2gitlabUser(comment.author.emailAddress);
                                if (author !== false) {
                                    this.gitlabClient.addHeader('SUDO', author.username);
                                }

                                if (attachments.length > 0) {
                                    comment.body = Sync.replaceAttachmentLinks(comment.body, attachments);
                                }

                                try {
                                    await this.gitlabClient.issues.createNote({
                                        id: gitlabIssue.project_id,
                                        issue_id: gitlabIssue.id,
                                        body: Sync.transformSyntax(comment.body)
                                    });
                                } catch (e) {
                                    winston.error('ERROR: Applying of comment failed: ', e);
                                }
                            }
                            this.gitlabClient.removeHeader('SUDO');
                        }

                        if (this.options.general.syncField === true) {
                            // updating jira issue with gitlab issueID
                            const jiraUpdate: any = {fields: {}};
                            jiraUpdate.fields[this.gitlabJiraField.id] = "" + gitlabIssue.id;
                            winston.info("Updating jira issue with ", jiraUpdate);
                            try {
                                await this.jiraClient.updateIssue(jiraIssue.id, jiraUpdate);
                            } catch {
                                winston.error('Could not update jira issue!');
                            }
                        }
                    }

                    // resolution available?
                    if (jiraIssue.fields.resolution !== null) {
                        winston.info("setting to closed...");
                        try {
                            await this.gitlabClient.issues.update({
                                id: gitlabIssue.project_id,
                                issue_id: gitlabIssue.id,
                                state_event: "close"
                            });
                        } catch (err) {
                            winston.error('ERROR: Could not close the issue!');
                        }

                    }
                }
            }
            resolve();
        });
    }

    /**
     * @method
     * Apply worklog and estimated time
     *
     * @param issue
     * @param gitlabIssue
     * @async
     */
    private async applyTimeLog(issue, gitlabIssue) {
        let note = 'Apply time entries from jira.';
        if (typeof issue.fields.timespent === "number"
            && issue.fields.timespent > 0
            && this.options.general.worklog === true) {
            winston.info("adding worklog: " + issue.fields.timespent);
            note += '\n/spend ' + issue.fields.timespent + 's';
        }
        if (typeof issue.fields.timeestimate === 'number'
            && issue.fields.timeestimate > 0
            && this.options.general.estimatedTime === true) {
            winston.info('adding estimated time: ' + issue.fields.timeestimate);
            note += '\n/estimate ' + issue.fields.timeestimate + 's';
        }
        try {
            await this.gitlabClient.issues.createNote({
                id: gitlabIssue.project_id,
                issue_id: gitlabIssue.id,
                body: note
            });
        } catch (e) {
            winston.error("Adding worklog and/or estimated time failed : ", e);
        }
    }

    /**
     * @method resolveMappingMacros
     *
     * Resolve the mapping macro defined in mapping rule
     *
     * @param issue
     * @param issueMapping
     * @param gitlabIssueJSON
     * @returns {any}
     */
    private resolveMappingMacros(issue, issueMapping, gitlabIssueJSON) {
        switch (issueMapping.gitlab) {
            case "$asLabel":
                gitlabIssueJSON.labels = this.resolveLabels(gitlabIssueJSON.labels, issue, issueMapping);
                break;
            default:
                throw new Error("Unknown operator: " + issueMapping.gitlab);
        }
        return gitlabIssueJSON;
    }

    /**
     * @method resolveLabels
     *
     * Resolve labels from the defined jira field
     *
     * @param labels
     * @param issue
     * @param issueMapping
     * @returns {any}
     */
    private resolveLabels(labels, issue, issueMapping) {
        let newLabels = [];
        let attribute = Sync.resolveAttribute(issue, issueMapping.jira);

        if (Array.isArray(attribute)) {
            if (typeof attribute[0] === 'object') {
                attribute = Sync.resolveObjectLabels(attribute, issueMapping);
            }
            newLabels = attribute;
        } else {
            newLabels.push(attribute);
        }

        if (issueMapping.ignore !== undefined) {
            newLabels = Sync.filterLabels(newLabels, issueMapping.ignore);
        }

        newLabels.forEach(function (value, index) {
            if (value === null || value === undefined || value === "null" || value === "undefined") {
                newLabels.splice(index, 1);
            }
        });

        if (issueMapping.prefix !== undefined) {
            for (let i = 0; i < newLabels.length; i++) {
                newLabels[i] = issueMapping.prefix + newLabels[i];
            }
        }

        let labelString = newLabels.join(',');

        if (labels === undefined)
            labels = labelString;
        else
            labels += "," + labelString;
        winston.info("  => New Label(s): " + labelString);
        return labels;
    }

    /**
     * @method resolveAttribute
     *
     * return the value of a defined jira mapping
     *
     * @param issue
     * @param attribute
     * @returns {any}
     */
    static resolveAttribute(issue, attribute) {
        let fieldArray = attribute.split('.');
        let object = issue;
        for (let i = 0; i < fieldArray.length; i++) {
            if (object[fieldArray[i]] !== undefined && object[fieldArray[i]] !== null ) {
                object = object[fieldArray[i]];
            } else {
                winston.info("WARNING: skipping field mapping for '" + attribute + "' since it doesn't exist on jira issue...");
                return undefined;
            }
        }
        return object;
    }

    /**
     * @method resolveObjectLabels
     *
     * Resolve labels from array of objects
     *
     * @param attribute
     * @param issueMapping
     * @returns {string}
     */
    static resolveObjectLabels(attribute, issueMapping) {
        let labels = [];

        if (issueMapping.field === undefined) {
            winston.error('WARNING: skipping field mapping for ' + issueMapping.jira + ' since "field" isn\'t defined.');
            return labels;
        }
        if (attribute[0][issueMapping.field] === undefined) {
            winston.error('WARNING: skipping field mapping for ' + issueMapping.jira + ' since field ' + issueMapping.field + 'isn\'t defined in objects.');
            return labels;
        }

        for (let i = 0; i < attribute.length; i++) {
            labels.push(attribute[i][issueMapping.field]);
        }
        return labels;
    }

    /**
     * @method mapUser
     * Maps a jira user to a gitlab user and returns the gitlab user object or false if mapping was not successful
     *
     * @param jiraMail The email of the jira user to map
     * @return {{}}|false The found gitlab user or false
     */
    private jira2gitlabUser(jiraMail) {
        let userMapping: UserMapping = _.find(this.options.userMapping, (um) => um.jiraMail === jiraMail);
        if (!userMapping) {
            winston.warn("WARNING: No userMapping found for jira user " + jiraMail);
        } else {
            let gitlabUser: any = _.find(this.gitlabProjectMembers, (gitlabProjectMember) => gitlabProjectMember.username === userMapping.gitlabUsername);
            if (gitlabUser) {
                winston.info("  => Found assigneeId " + gitlabUser.id);
                return gitlabUser;
            } else {
                winston.warn("WARNING: Could not find gitlab user " + userMapping.gitlabUsername + " in gitlab project!!!");
            }
        }
        return false;
    }

    /**
     * @method filterLabels
     * Remove labels based on the filters provided in the matching rule
     *
     * @param {string[]} newLabels Array of new labels
     * @param {string[]} ignore Array of regex strings defining the labels to remove
     * @returns {string[]}
     */
    static filterLabels(newLabels, ignore: any) {
        let regs = [];
        ignore.forEach(function (value) {
            regs.push(new RegExp(value));
        });

        for (let i = 0; i < newLabels.length; i++) {
            let remove = false;
            for (let j = 0; j < regs.length; j++) {
                if (regs[j].test(newLabels[i]) === true) {
                    remove = true;
                    break;
                }
            }
            if (remove === true) {
                winston.info('  => ignoring label ' + newLabels[i]);
                newLabels.splice(i, 1);
                i--;
            }
        }

        return newLabels;
    }

    /**
     * @method applyAttachments
     * Upload attachments from the jira issue to gitlab and return an array of gitlab infos to the uploaded attachments
     *
     * @param jiraIssue
     * @param gitlabProjectId
     * @returns {}[]
     */
    private async applyAttachments(jiraIssue, gitlabProjectId) {
        let data = [];
        let tmpPath = path.resolve(__dirname, '../tmp/');
        if (!fs.existsSync(tmpPath)) {
            fs.mkdirSync(tmpPath)
        }
        let header = 'Authorization: Basic ' + new Buffer(this.options.jira.username + ':' + this.options.jira.password).toString('base64');
        let count = jiraIssue.fields.attachment.length;
        for (let i = 0; i < jiraIssue.fields.attachment.length; i++) {
            let item = jiraIssue.fields.attachment[i];
            try {
                let command = 'curl -D- -X GET -H "' +
                    header +
                    '" -H "Content-Type: application/json" "http://jira.devnet.sectornord.com/secure/attachment/' +
                    item.id + '/' + item.filename + '" --output "' + tmpPath + '/' + item.filename + '"';
                execSync(command);
            } catch (err) {
                winston.error('ERROR: Attachment could not be downloaded.', err);
                count--;
                continue;
            }
            try {
                let sendCommand = 'curl --request POST --header "PRIVATE-TOKEN: ' +
                    this.options.gitlab.privateToken + '" --form "file=@' + tmpPath + '/' +
                    item.filename + '" ' + this.options.gitlab.url + '/api/v3/projects/' + gitlabProjectId + '/uploads';
                let response = execSync(sendCommand);
                let fileData = JSON.parse(response.toString('utf8'));
                fileData.name = item.filename;
                data.push(fileData);
            } catch (err) {
                winston.error('ERROR: Attachment could not be uploaded.', err)
            }
            count--;
        }

        while (count > 0) {}

        try {
            execSync('rm ' + tmpPath + '/*');
        } catch (err) {
            winston.warn('WARNING: Cleaning of local attachment copies failed. Please remove them manually from ' + tmpPath);
        }

        winston.info('  => Applied ' + jiraIssue.fields.attachment.length + ' attachments');
        return data;
    }

    /**
     * @method replaceAttachmentLinks
     * Replace all jira attachment links with the corresponding gitlab attachment links
     *
     * @param {string} comment The comment body
     * @param {{}[]} attachments The array of attachments
     * @returns {string}
     */
    static replaceAttachmentLinks(comment, attachments) {

        // Return the link to the gitlab attachment
        let replaceLinks = function(match, p1, p2) {
            let name = p2;
            if (p1 !== undefined) {
                name = p1.replace('|thumbnail', '');
            }
            for (let i = 0; i < attachments.length; i++) {
                if (attachments[i].name === name) {
                    return attachments[i].markdown;
                }
            }
            return name + '|unavailable'
        };

        //replace attachment links
        let reg = /!(.*?)!|\[\^(.*)]?]/g;
        if (reg.test(comment)) {
            comment = comment.replace(reg, replaceLinks);
        }
        return comment;
    }

    /**
     * @method transformSyntax
     * Transforms the jira syntax to gitlab syntax
     *
     * @param {string} text The jira text to parse
     * @returns {string} The parsed text with gitlab syntax
     */
    static transformSyntax(text) {
        text = text
            .replace(/\*([^\s].*?[^\s])\*/g, '\*\*$1\*\*')
            .replace(/_([^\s].*?[^\s])_/g, '\*$1\*')
            .replace(/\/([^\s].*?[^\s])\//g, '_$1_')
            .replace(/-([^\s].*?[^\s])-/g, '~~$1~~')
            .replace(/\+([^\s].*?[^\s])\+/g, '$1')
            .replace(/\[~(.*?)\]/g, '@$1')
            .replace(/{code:(.*?)}([\s\S]*?){code}/g, '```$1\n$2\n```')
            .replace(/{color:.*?}([^\s].*?[^\s]){color}/g, '$1');
        return text;
    }

    /**
     * @method checkIgnoreIssue
     * Checks if the issue should not be imported due to defined filter settings
     *
     * @param jiraIssue The jira issue data
     * @returns {boolean}
     */
    private checkIgnoreIssue(jiraIssue) {
        if (this.options.general.ignoreIssues.closed === true && jiraIssue.fields.resolution !== null) {
            return true;
        }

        if (this.options.general.ignoreIssues.date === true) {
            let before = new Date(this.options.general.ignoreIssues.dateConfig.date);
            let date = new Date(jiraIssue.fields[this.options.general.ignoreIssues.dateConfig.type]);
            if (date < before) {
                return true;
            }
        }

        return false;
    }
}