import {test, expect}                from '@playwright/test';
import {reconcileDiscussionActivity} from '../../../../../../../ai/services/github-workflow/community/githubDiscussionReconciliation.mjs';

const createdAt = '2026-07-01T10:00:00Z', updatedAt = '2026-07-02T10:00:00Z';

/** @summary Builds independent provider connections and records their cursor use. */
function fixture({rootCount=2, commentCount=51, replyCount=51}={}) {
    const roots  = [], comments=new Map(), replies=new Map(), entities=new Map(), edits=new Map(), calls=[];
    const entity = (id, extra={}) => {
        const node = {id, createdAt, updatedAt, lastEditedAt: null,
            author: {login:'external', __typename:'User'}, authorAssociation:'NONE', ...extra};
        entities.set(id, node); edits.set(id, []); return node;
    };
    const connection = (nodes, cursor, size=20) => {
        const start = cursor === null ? 0 : Number(cursor), end = Math.min(start+size, nodes.length);
        return {nodes: structuredClone(nodes.slice(start,end)), totalCount:nodes.length,
            pageInfo:{hasNextPage:end<nodes.length, endCursor:end ? String(end) : null}};
    };
    for (let r=0; r<rootCount; r++) {
        const id = `D${r}`, children=[], root=entity(id,{number:r+1, closed:r===0, comments:{totalCount:commentCount}});
        roots.push(root); comments.set(id, children);
        for (let c=0; c<commentCount; c++) {
            const commentId = `${id}C${c}`, nested=[], count=c===0 ? replyCount : 0;
            const comment   = entity(commentId,{discussion:{id}, replyTo:null, replies:{totalCount:count}});
            children.push(comment); replies.set(commentId,nested);
            for (let n=0; n<count; n++) nested.push(entity(`${commentId}R${n}`,{
                discussion:{id}, replyTo:{id:commentId}, replies:{totalCount:0}
            }));
        }
    }
    const rootPage = cursor => {
        const page = connection(roots,cursor,1);
        return {discussions:page.nodes,pageInfo:page.pageInfo,totalCount:page.totalCount};
    };
    const editNode = (id,cursor=null) => ({...structuredClone(entities.get(id)),
        includesCreatedEdit:false,userContentEdits:connection(edits.get(id),cursor,2)});
    const seams = {
        fetchDiscussionsPage:async ({cursor}) => {calls.push(['roots',cursor]);return rootPage(cursor)},
        fetchCommentsPage:async ({discussionId,cursor}) => {
            calls.push(['comments',discussionId,cursor]);
            return {id:discussionId,updatedAt:entities.get(discussionId).updatedAt,
                comments:connection(comments.get(discussionId),cursor)};
        },
        fetchRepliesPage:async ({commentId,cursor}) => {
            calls.push(['replies',commentId,cursor]);
            return {id:commentId,updatedAt:entities.get(commentId).updatedAt,
                replies:connection(replies.get(commentId),cursor)};
        },
        fetchContentEditHeads:async ({entities:expected}) => expected.map(item=>({status:'fulfilled',value:editNode(item.id)})),
        fetchContentEditsPage:async ({entityNodeId,cursor}) => {calls.push(['edits',entityNodeId,cursor]);return editNode(entityNodeId,cursor)},
        verifyContentEntities:async ({entities:expected}) => expected.map(item=>({status:'fulfilled',value:structuredClone(entities.get(item.id))})),
        fetchCensusPage:async ({cursor}) => rootPage(cursor)
    };
    return {seams,roots,comments,replies,entities,edits,calls};
}

test.describe('Discussion community reconciliation',()=>{
    test('exhausts active and closed roots plus independent 50+ comments and replies',async()=>{
        const f = fixture(), result=await reconcileDiscussionActivity(f.seams);
        expect(result.currentInventory).toEqual(['D0','D1']);
        expect(result.observations.filter(x=>x.occurrenceKind==='discussion.comment')).toHaveLength(102);
        expect(result.observations.filter(x=>x.occurrenceKind==='discussion.reply')).toHaveLength(102);
        expect(result.currentEntityInventory).toHaveLength(206);
        expect(f.calls.filter(x=>x[0]==='comments'&&x[1]==='D0').map(x=>x[2])).toEqual([null,'20','40']);
        expect(f.calls.filter(x=>x[0]==='replies'&&x[1]==='D0C0').map(x=>x[2])).toEqual([null,'20','40']);
        expect(result.coverage.gaps.map(x=>x.axis)).toEqual([
            'discussion-state-history','discussion-deletions','discussion-child-deletions'
        ]);
    });

    test('finds a later reply edit while its closed root updatedAt remains unchanged',async()=>{
        const f      = fixture({rootCount:1,commentCount:1,replyCount:1});
        const before = await reconcileDiscussionActivity(f.seams), rootStamp=f.roots[0].updatedAt;
        f.entities.get('D0C0R0').updatedAt='2026-07-03T10:00:00Z';
        f.entities.get('D0C0R0').lastEditedAt='2026-07-03T10:00:00Z';
        f.edits.set('D0C0R0',[{id:'EDIT1',editedAt:'2026-07-03T10:00:00Z',editor:{login:'external',__typename:'User'}}]);
        const after = await reconcileDiscussionActivity(f.seams);
        expect(f.roots[0].updatedAt).toBe(rootStamp);
        expect(before.observations.some(x=>x.occurrenceKind==='discussion.reply-edited')).toBe(false);
        expect(after.observations).toContainEqual(expect.objectContaining({providerEntityId:'D0C0R0',
            parentProviderEntityId:'D0C0',occurrenceKind:'discussion.reply-edited',occurrenceCoordinate:'EDIT1'}));
        expect(f.calls.filter(x=>x[0]==='roots'&&x[1]===null)).toHaveLength(2);
    });

    test('exhausts revision pages and removes only the provider-marked creation revision',async()=>{
        const f = fixture({rootCount:1,commentCount:0,replyCount:0});
        f.roots[0].lastEditedAt='2026-07-01T13:00:00Z';
        f.edits.set('D0',[{id:'CREATE',editedAt:createdAt},
            ...[11,12,13].map(hour=>({id:`E${hour}`,editedAt:`2026-07-01T${hour}:00:00Z`}))]);
        const heads = f.seams.fetchContentEditHeads, page=f.seams.fetchContentEditsPage;
        f.seams.fetchContentEditHeads=async args=>(await heads(args)).map(x=>({...x,value:{...x.value,includesCreatedEdit:true}}));
        f.seams.fetchContentEditsPage=async args=>({...await page(args),includesCreatedEdit:true});
        const result = await reconcileDiscussionActivity(f.seams);
        expect(result.observations.filter(x=>x.occurrenceKind==='discussion.edited').map(x=>x.occurrenceCoordinate)).toEqual(['E11','E12','E13']);
        expect(f.calls).toContainEqual(['edits','D0','2']);
    });

    for (const [name,mutate,expected] of [
        ['stalled comment cursor',f=>{f.seams.fetchCommentsPage=async()=>({id:'D0',updatedAt,comments:{
            nodes:[f.comments.get('D0')[0]],totalCount:51,pageInfo:{hasNextPage:true,endCursor:null}}})},'CURSOR_STALLED'],
        ['child count changes',f=>{const old=f.seams.fetchRepliesPage;f.seams.fetchRepliesPage=async a=>{const p=await old(a);p.replies.totalCount++;return p}},'COUNT_MUTATED'],
        ['reply revision changes without root mutation',f=>{const old=f.seams.verifyContentEntities;f.seams.verifyContentEntities=async a=>{const values=await old(a);values.at(-1).value.updatedAt='2026-07-04T00:00:00Z';return values}},'CONTENT_MUTATED'],
        ['reply added during verification',f=>{const old=f.seams.verifyContentEntities;f.seams.verifyContentEntities=async a=>{const values=await old(a);values.find(x=>x.value.id==='D0C0').value.replies.totalCount++;return values}},'CHILDREN_MUTATED'],
        ['root membership changes during verification',f=>{const old=f.seams.fetchCensusPage;f.seams.fetchCensusPage=async a=>{const p=await old(a);p.discussions[0].id='DIFFERENT';return p}},'ROOT_MEMBERSHIP_MUTATED'],
        ['child access disappears',f=>{f.seams.fetchRepliesPage=async()=>{throw new Error('provider permission denied')}},'permission denied']
    ]) {
        test(`refuses mixed observations when ${name}`,async()=>{
            const f      = fixture({rootCount:1});mutate(f);
            const result = await reconcileDiscussionActivity(f.seams);
            expect(result.observations).toEqual([]);
            expect(result.coverage.complete).toBe(false);
            expect(result.coverage.gaps.some(g=>g.reason.includes(expected))).toBe(true);
            expect(result.currentInventory).toEqual(['D0']);
        });
    }

    test('a root page cap retains observed inventory and names incomplete coverage',async()=>{
        const f      = fixture({commentCount:0,replyCount:0});
        const result = await reconcileDiscussionActivity(f.seams,{maxRootPages:1});
        expect(result.currentInventory).toEqual(['D0']);
        expect(result.coverage.gaps).toContainEqual({axis:'discussions',reason:'page-cap'});
        expect(result.observations.some(x=>x.providerEntityId==='D1')).toBe(false);
    });

    test('reply and edit caps do not publish a partial root snapshot',async()=>{
        const f     = fixture({rootCount:1,commentCount:1});
        const reply = await reconcileDiscussionActivity(f.seams,{maxReplyPagesPerComment:1});
        expect(reply.observations).toEqual([]);
        expect(reply.currentEntityInventory).toContain('D0C0R0');
        const edit = await reconcileDiscussionActivity(f.seams,{maxEditPagesPerEntity:0});
        expect(edit.observations).toEqual([]);
        expect(edit.coverage.gaps.some(x=>x.reason==='page-cap')).toBe(true);
    });

    test('a provider request failure is an access gap, never evidence of deletion',async()=>{
        const f      = fixture();f.seams.fetchDiscussionsPage=async()=>{throw new Error('resource inaccessible')};
        const result = await reconcileDiscussionActivity(f.seams);
        expect(result.observations).toEqual([]);
        expect(result.coverage.gaps).toContainEqual({axis:'discussions',reason:'resource inaccessible'});
        expect(result.currentEntityInventory).toEqual([]);
    });
});
