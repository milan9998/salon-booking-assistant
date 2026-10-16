using System.Data;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Storage;
using SalonBooking.Application.Common;

namespace SalonBooking.Infrastructure.Persistence;

public sealed class BookingTransactionRunner(BookingDbContext db) : IBookingTransactionRunner
{
    public async Task<T> ExecuteWithLocksAsync<T>(
        IReadOnlyCollection<string> lockKeys,
        Func<CancellationToken, Task<T>> operation,
        CancellationToken cancellationToken)
    {
        await using var transaction = await db.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted, cancellationToken);
        foreach (var lockKey in lockKeys.Distinct(StringComparer.Ordinal).OrderBy(x => x, StringComparer.Ordinal))
            await AcquireTransactionLockAsync(transaction, lockKey, cancellationToken);

        var result = await operation(cancellationToken);
        await transaction.CommitAsync(cancellationToken);
        return result;
    }

    private async Task AcquireTransactionLockAsync(
        IDbContextTransaction transaction,
        string lockKey,
        CancellationToken cancellationToken)
    {
        await using var command = db.Database.GetDbConnection().CreateCommand();
        command.Transaction = transaction.GetDbTransaction();
        command.CommandText = "SELECT pg_advisory_xact_lock(hashtextextended(@lock_key, 0))";
        var parameter = command.CreateParameter();
        parameter.ParameterName = "lock_key";
        parameter.Value = lockKey;
        command.Parameters.Add(parameter);
        await command.ExecuteScalarAsync(cancellationToken);
    }
}
