const { Sequelize } = require('sequelize')

/**
 * Keeps libraryItems title and author-name columns in sync with books, podcasts, bookAuthors and authors.
 * SQLite has these triggers already. Triggers are created only when missing and are scoped to the table they
 * fire on. A backfill runs after they are installed, so rows written before the trigger existed are repaired.
 * Only rows that differ are updated.
 */

const TITLE_FIELDS = ['title', 'titleIgnorePrefix']

async function installFunction(sequelize, name, body) {
  await sequelize.query(`CREATE OR REPLACE FUNCTION ${pgName(name)}() RETURNS trigger AS $func$
    BEGIN
      ${body}
    END;
    $func$ LANGUAGE plpgsql`)
}

// Postgres keeps only the first 63 bytes of an identifier. Check the name it will actually be stored under.
const pgName = (name) => name.slice(0, 63)

async function installTrigger(sequelize, adapter, logger, { name, table, event, functionName }) {
  const stored = pgName(name)
  if (await adapter.triggerExists(table, stored)) return
  logger.info(`[fork-pg-0005-denormalized-library-items] Adding trigger ${stored} on ${table}`)
  await sequelize.query(`CREATE TRIGGER ${stored} ${event} ON ${table} FOR EACH ROW EXECUTE FUNCTION ${pgName(functionName)}()`)
}

const authorNamesSql = (bookIdExpr) => `
  SELECT string_agg(a.name, ', ' ORDER BY ba.createdat ASC) AS firstlast, string_agg(a.lastfirst, ', ' ORDER BY ba.createdat ASC) AS lastfirst
  FROM bookauthors ba JOIN authors a ON a.id = ba.authorid WHERE ba.bookid = ${bookIdExpr}`

module.exports = {
  id: 'fork-pg-0005-denormalized-library-items',
  phase: 'after',
  description: 'libraryItems title and author-name triggers and backfill',
  async run({ sequelize, adapter, logger }) {
    // Title columns, from books and podcasts.
    for (const source of ['books', 'podcasts']) {
      if (!(await adapter.tableExists(source))) continue
      for (const column of TITLE_FIELDS) {
        // Names match the trigger names the deployed fork created, so existing databases are not duplicated.
        const snake = column.replace(/([A-Z])/g, '_$1').toLowerCase()
        const fromSource = source === 'books' ? '' : `_from_${source}_${snake}`
        const name = `update_library_items_${snake}${fromSource}`
        const functionName = `${name}_fn`
        const physical = column.toLowerCase()
        await installFunction(sequelize, functionName, `UPDATE libraryitems SET ${physical} = NEW.${physical} WHERE mediaid = NEW.id; RETURN NEW;`)
        await installTrigger(sequelize, adapter, logger, { name, table: source, event: `AFTER UPDATE OF ${physical}`, functionName })
        await sequelize.query(`UPDATE libraryitems li SET ${physical} = s.${physical} FROM ${source} s WHERE li.mediaid = s.id AND li.${physical} IS DISTINCT FROM s.${physical}`)
      }
    }

    // Author names, from bookAuthors and authors.
    const authorTriggers = [
      { name: 'update_library_items_author_names_on_book_authors_insert', table: 'bookauthors', event: 'AFTER INSERT', record: 'NEW' },
      { name: 'update_library_items_author_names_on_book_authors_delete', table: 'bookauthors', event: 'AFTER DELETE', record: 'OLD' },
      { name: 'update_library_items_author_names_on_book_authors_update', table: 'bookauthors', event: 'AFTER UPDATE', record: 'NEW' }
    ]
    if (await adapter.tableExists('bookAuthors')) {
      for (const trigger of authorTriggers) {
        const functionName = `${trigger.name}_fn`
        const body = `UPDATE libraryitems SET (authornamesfirstlast, authornameslastfirst) = (SELECT firstlast, lastfirst FROM (${authorNamesSql(`${trigger.record}.bookid`)}) s) WHERE mediaid = ${trigger.record}.bookid; RETURN ${trigger.record};`
        await installFunction(sequelize, functionName, body)
        await installTrigger(sequelize, adapter, logger, { name: trigger.name, table: trigger.table, event: trigger.event, functionName })
      }
    }
    if (await adapter.tableExists('authors')) {
      const name = 'update_library_items_author_names_on_authors_update'
      const functionName = `${name}_fn`
      await installFunction(sequelize, functionName, `UPDATE libraryitems SET (authornamesfirstlast, authornameslastfirst) = (SELECT firstlast, lastfirst FROM (${authorNamesSql('libraryitems.mediaid')}) s) WHERE mediaid IN (SELECT bookid FROM bookauthors WHERE authorid = NEW.id); RETURN NEW;`)
      await installTrigger(sequelize, adapter, logger, { name, table: 'authors', event: 'AFTER UPDATE OF name, lastFirst', functionName })
    }

    // Backfill author names for every book: recompute, and clear rows whose book has no authors.
    await sequelize.query(`
      UPDATE libraryitems li SET authornamesfirstlast = s.firstlast, authornameslastfirst = s.lastfirst
      FROM (SELECT ba.bookid, string_agg(a.name, ', ' ORDER BY ba.createdat ASC) AS firstlast, string_agg(a.lastfirst, ', ' ORDER BY ba.createdat ASC) AS lastfirst
            FROM bookauthors ba JOIN authors a ON a.id = ba.authorid GROUP BY ba.bookid) s
      WHERE li.mediatype = 'book' AND li.mediaid = s.bookid
        AND (li.authornamesfirstlast IS DISTINCT FROM s.firstlast OR li.authornameslastfirst IS DISTINCT FROM s.lastfirst)`)
    await sequelize.query(`
      UPDATE libraryitems li SET authornamesfirstlast = NULL, authornameslastfirst = NULL
      WHERE li.mediatype = 'book' AND NOT EXISTS (SELECT 1 FROM bookauthors ba WHERE ba.bookid = li.mediaid)
        AND (li.authornamesfirstlast IS NOT NULL OR li.authornameslastfirst IS NOT NULL)`)
  }
}
