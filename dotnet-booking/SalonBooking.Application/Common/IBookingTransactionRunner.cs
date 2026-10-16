namespace SalonBooking.Application.Common;

/// <summary>
/// Runs a booking operation atomically while serializing requests that share
/// one or more logical booking resources (for example a worker/day and a customer).
/// </summary>
public interface IBookingTransactionRunner
{
    Task<T> ExecuteWithLocksAsync<T>(
        IReadOnlyCollection<string> lockKeys,
        Func<CancellationToken, Task<T>> operation,
        CancellationToken cancellationToken);
}
