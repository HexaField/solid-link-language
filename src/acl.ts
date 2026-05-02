/**
 * WAC (Web Access Control) permission management.
 *
 * Manages ACL resources for Solid Pod containers to control
 * access to Neighbourhood data per Spec §7.
 *
 * No ad4m:host imports — uses injected adapters only.
 */

import type { MembershipMode } from "./settings.js";
import { ldpPut } from "./ldp.js";
import { aclResourceUrl, membersResourceUrl } from "./ldp.pure.js";
import { ACL_NS, FOAF_NS, VCARD_NS } from "./ontology.js";

// ---------------------------------------------------------------------------
// ACL Generation
// ---------------------------------------------------------------------------

/**
 * Generate a WAC ACL document for a container based on membership mode.
 *
 * @param containerUrl The container this ACL protects
 * @param ownerWebId The WebID of the Pod owner
 * @param membersUrl URL of the members registry
 * @param mode Membership mode (open, members-only, private)
 * @returns Turtle string for the ACL resource
 */
export function generateAcl(
    containerUrl: string,
    ownerWebId: string,
    membersUrl: string,
    mode: MembershipMode,
): string {
    const lines: string[] = [
        `@prefix acl: <${ACL_NS}> .`,
        `@prefix foaf: <${FOAF_NS}> .`,
        "",
        "# Owner has full control",
        "<#owner> a acl:Authorization ;",
        `    acl:agent <${ownerWebId}> ;`,
        `    acl:accessTo <${containerUrl}> ;`,
        `    acl:default <${containerUrl}> ;`,
        "    acl:mode acl:Read, acl:Write, acl:Control .",
        "",
    ];

    switch (mode) {
        case "open":
            lines.push(
                "# Public read and write",
                "<#public> a acl:Authorization ;",
                `    acl:agentClass foaf:Agent ;`,
                `    acl:accessTo <${containerUrl}> ;`,
                `    acl:default <${containerUrl}> ;`,
                "    acl:mode acl:Read, acl:Write .",
            );
            break;

        case "members-only":
            lines.push(
                "# Members can read and write",
                "<#members> a acl:Authorization ;",
                `    acl:agentGroup <${membersUrl}#group> ;`,
                `    acl:accessTo <${containerUrl}> ;`,
                `    acl:default <${containerUrl}> ;`,
                "    acl:mode acl:Read, acl:Write .",
                "",
                "# Public can read",
                "<#public> a acl:Authorization ;",
                `    acl:agentClass foaf:Agent ;`,
                `    acl:accessTo <${containerUrl}> ;`,
                `    acl:default <${containerUrl}> ;`,
                "    acl:mode acl:Read .",
            );
            break;

        case "private":
            lines.push(
                "# Members can read and write (no public access)",
                "<#members> a acl:Authorization ;",
                `    acl:agentGroup <${membersUrl}#group> ;`,
                `    acl:accessTo <${containerUrl}> ;`,
                `    acl:default <${containerUrl}> ;`,
                "    acl:mode acl:Read, acl:Write .",
            );
            break;
    }

    return lines.join("\n");
}

/**
 * Generate a members registry document.
 *
 * @param memberWebIds Array of member WebID URLs
 * @returns Turtle string for the members registry
 */
export function generateMembersRegistry(memberWebIds: string[]): string {
    const lines: string[] = [
        `@prefix vcard: <${VCARD_NS}> .`,
        "",
        "<#group> a vcard:Group ;",
    ];

    for (let i = 0; i < memberWebIds.length; i++) {
        const terminator = i === memberWebIds.length - 1 ? " ." : " ;";
        lines.push(`    vcard:hasMember <${memberWebIds[i]}>${terminator}`);
    }

    if (memberWebIds.length === 0) {
        // Empty group — replace the unterminated last line
        lines[lines.length - 1] = "<#group> a vcard:Group .";
    }

    return lines.join("\n");
}

// ---------------------------------------------------------------------------
// ACL Operations
// ---------------------------------------------------------------------------

/**
 * Set the ACL for a container on the Pod.
 */
export async function setContainerAcl(
    containerUrl: string,
    ownerWebId: string,
    membersUrl: string,
    mode: MembershipMode,
    authToken?: string,
): Promise<boolean> {
    const aclUrl = aclResourceUrl(containerUrl);
    const aclBody = generateAcl(containerUrl, ownerWebId, membersUrl, mode);
    const response = await ldpPut(aclUrl, aclBody, "text/turtle", authToken);
    return response.status >= 200 && response.status < 300;
}

/**
 * Update the members registry on the Pod.
 */
export async function updateMembersRegistry(
    podUrl: string,
    containerPath: string,
    memberWebIds: string[],
    authToken?: string,
): Promise<boolean> {
    const url = membersResourceUrl(podUrl, containerPath);
    const body = generateMembersRegistry(memberWebIds);
    const response = await ldpPut(url, body, "text/turtle", authToken);
    return response.status >= 200 && response.status < 300;
}

/**
 * Add a member to the registry.
 */
export async function addMember(
    podUrl: string,
    containerPath: string,
    currentMembers: string[],
    newMemberWebId: string,
    authToken?: string,
): Promise<boolean> {
    if (currentMembers.includes(newMemberWebId)) return true;
    const updatedMembers = [...currentMembers, newMemberWebId];
    return updateMembersRegistry(podUrl, containerPath, updatedMembers, authToken);
}

/**
 * Remove a member from the registry.
 */
export async function removeMember(
    podUrl: string,
    containerPath: string,
    currentMembers: string[],
    memberWebId: string,
    authToken?: string,
): Promise<boolean> {
    const updatedMembers = currentMembers.filter(m => m !== memberWebId);
    return updateMembersRegistry(podUrl, containerPath, updatedMembers, authToken);
}
