# Disclaimer

This is a fork of [smallstacks jira2gitlab](https://gitlab.com/smallstack/jira2gitlab). I have fixed some bugs and added 
additional behaviour

---

# Motivation

We recently moved from Jira/Bitbucket to Gitlab. Since there was no importer for Jira Issues that supports (custom-)field 
mapping, we wrote this CLI tool.

## Current Features

### Basic

- Syncs issues based on configuration
- Re-Sync works via custom jira field that stores the Gitlab issue ID
- Jira (custom-)fields can be mapped to Gitlab fields
- Jira users can be mapped to Gitlab users
- If a jira resolution exists, the issue will be closed on Gitlab
- Map fields with single value, array of values and even array of objects to gitlab labels

### Optional

- Jira worklogs get added once on gitlab issue creation
- Jira estimated time get added to gitlab issue
- Backlink to original issue as comment
- Add issues as the original author if mapped (defined gitlab user needs to have administration permissions)

## simple

Basically nearly any jira issue field containing a single value (string, integer, float, boolean) can be imported to a 
gitlab issue field.
You can simply add mappings containing a `jira` and a `gitlab` attribute.

```json
"issueMapping": [
    {
        "jira": "fields.summary",
        "gitlab": "title"
    },
    {
        "jira": "fields.description",
        "gitlab": "description"
    }
]

```

## $asLabel

To import jira fields as labels you can use the special macro `$asLabel`. If the defined jira field is an array of 
simple types like in `fields.labels` all entries are imported as labels.

If you want to import fields that contain an array of objects (for example the `fields.components` array), you can define
the object field to import as label through the `field`-attribute inside the mapping rule:

```json
{
    "jira": "fields.components",
    "gitlab": "$asLabel",
    "field": "name"
}
```

## Things to know

- The CLI creates a new custom field in Jira called 'jira2gitlab' where it stores the gitlab issue ID. This custom field 
is automatically added to the 'default screen' of Jira.
- We imply that, after syncing an issue from Jira to Gitlab, the issue is being processed further on Gitlab only. 
This is currently only relevant for the timespent field (which will not get updated again on a re-sync)

# How-to install
 
## via source

Clone the project and call `npm install -g`

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
        "strictSSL": true,
        "protocol": "http|https"
    },
    "gitlab": {
        "url": "https://gitlab.com",
        "privateToken": "XXX",
        "namespace": "smallstack",
        "projectName": "cuppy"
    },
    "general": {
        "worklog": true,
        "estimatedTime": true,
        "backlink": true,
        "asOriginalAuthor": true
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
