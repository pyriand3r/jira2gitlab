# Motivation
We recently moved from Jira/Bitbucket to Gitlab. Since there was no importer for Jira Issues that supports (custom-)field mapping, we wrote this CLI tool.

## Current Features
- Syncs issues based on configuration
- Re-Sync works via custom jira field that stores the Gitlab issue ID
- Jira worklogs get added once on gitlab issue creation
- Jira (custom-) fields can be mapped to Gitlab fields
- Jira users can be mapped to Gitlab users
- If a jira resolution exists, the issue will be closed on Gitlab

## Things to know
- The CLI creates a new custom field in Jira called 'jira2gitlab' where it stores the gitlab issue ID. This custom field is automatically added to the 'default screen' of Jira.
- We imply that, after syncing an issue from Jira to Gitlab, the issue is being processed further on Gitlab only. This is currently only relevant for the timespent field (which will not get updated again on a re-sync)

# How-to install 
## via source
Clone the project and call `npm install -g`

## via npm registry
`npm install -g @smallstack/jira2gitlab`

## as project dependency
`npm install @smallstack/jira2gitlab --save`

# How-to use
You need an administrator account on Jira side and a private token that is allowed to modify project issues on gitlab's side. 

Create a config.json and add the following content: 

```json
{
    "jira": {
        "host": "jira.smallstack.io",
        "username": "max",
        "password": "XXX",
        "projectKey": "CUPPY",
        "strictSSL": true
    },
    "gitlab": {
        "url": "https://gitlab.com",
        "privateToken": "XXX",
        "namespace": "smallstack",
        "projectName": "cuppy"
    },
    "issueMapping": [
        {
            "jira": "fields.issuetype.name",
            "gitlab": "$asLabel"
        },
        {
            "jira": "fields.summary",
            "gitlab": "title"
        },
        {
            "jira": "fields.description",
            "gitlab": "description"
        }
    ],
    "userMapping": [
        {
            "jiraMail": "max@smallstack.io",
            "gitlabUsername": "maxfriedmann"
        },
        {
            "jiraMail": "timo@smallstack.io",
            "gitlabUsername": "timokaiser"
        }
    ]
}
```

Afterwards you can call the CLI in this folder via:

```bash
$ jira2gitlab
```
